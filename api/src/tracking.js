import { DurableObject } from "cloudflare:workers";
import { EmtError } from "./errors.js";
import { sendPush, validateSubscription, subscriptionId } from "./push.js";
import { bikeTransition, busTransition, notificationText } from "./tracking-rules.js";
import { bikeFeed, stopPoller } from "./pollers.js";

export function validateWatch(input) {
  if (!input || !["bus", "bike"].includes(input.kind) || !/^\d{1,8}$/.test(input.targetId ?? "")) {
    throw new EmtError("bad_request", "Choose a bus stop or bike station");
  }
  const line = String(input.line ?? "").trim().toUpperCase();
  if (input.kind === "bus" && !/^[A-Z0-9]{1,8}$/.test(line)) throw new EmtError("bad_request", "Choose a bus line");
  const destination = typeof input.destination === "string" ? input.destination.trim().slice(0, 160) : "";
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 120) : "";
  const watch = { kind: input.kind, targetId: String(input.targetId), label, line: input.kind === "bus" ? line : "", destination: input.kind === "bus" ? destination : "" };
  const coordinates = watchCoordinates(input.coordinates);
  // Coordinates are not part of the identity: the same stop tracked from a
  // card that knows where it is and one that does not is one watch.
  return { ...watch, ...(coordinates ? { coordinates } : {}), id: JSON.stringify([watch.kind, watch.targetId, watch.line, watch.destination]) };
}

/** GeoJSON [lon, lat] for the notification's directions link, or null.
 *  Bounded to the Madrid region so a watch cannot carry an arbitrary point. */
function watchCoordinates(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -5 || lon > -2.5 || lat < 39.5 || lat > 41.5) return null;
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

/** How often a watch's last-check time is persisted while nothing else about
 *  it changes: enough for "checked 12:04" to stay roughly true after the
 *  object is evicted, without a write per poll. */
const LAST_CHECK_WRITE = 10 * 60_000;
const RESYNC = 24 * 60 * 60_000;
/** A device is "seen" whenever the page opens on it (it re-registers its push
 *  subscription then). One not seen for DEVICE_PAUSE gets no alerts, and a
 *  user with no device left seen stops their pollers, so a lost phone or a
 *  wiped browser stops spending quota and sending pushes within days. It
 *  comes back the next time the app opens there. After DEVICE_FORGET it is
 *  deleted outright. */
export const DEVICE_PAUSE = 5 * 86_400_000;
export const DEVICE_FORGET = 30 * 86_400_000;
/** How stale a device's seenAt may get before a check-in rewrites it: every
 *  page load checks in, and most of them need not cost a storage write. */
const SEEN_WRITE = 6 * 60 * 60_000;

// One object per authenticated user: their watches, their devices, their alert
// state. It fetches nothing itself. The shared pollers in pollers.js fetch each
// stop's board and the city's bike counts once for every user and hand them
// here (onBoard / onBikes); this object only decides whether that is news for
// its user and sends the push. So ten people tracking one stop cost one EMT
// call per check, and a runner writes storage only when its state changes.
//
// Subscriptions to the pollers are kept by sync(), called whenever watches,
// devices or the EMT connection change, and once a day from the alarm as a
// safety net (which is also how runners from the self-polling era migrate).
export class TrackingRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Subscriptions the push service answered 404/410 for. A browser keeps
    // handing back its dead subscription, so without this list re-enabling
    // re-registered it, the next send dropped it again, and checks stopped.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS expired (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // user id, EMT connection (ciphertext only), current poller subscriptions.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.checked = new Map(); // watch id → last check, persisted only now and then
    this.busy = new Set(); // watches mid-evaluation: a slow push must not overlap the next poll
  }

  rows(table) { return this.ctx.storage.sql.exec(`SELECT id, value FROM ${table}`).toArray().map((r) => ({ id: r.id, ...JSON.parse(r.value) })); }
  watch(id) { const row = this.ctx.storage.sql.exec("SELECT value FROM watches WHERE id = ?", id).toArray()[0]; return row ? JSON.parse(row.value) : null; }
  save(watch) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO watches VALUES (?, ?)", watch.id, JSON.stringify(watch)); }
  devices() { return this.rows("devices"); }
  /** Devices seen lately; the only ones alerts go to. Devices from before
   *  seenAt existed count as seen until sync() stamps them. */
  activeDevices(now = Date.now()) {
    return this.devices().filter((d) => d.seenAt == null || now - d.seenAt < DEVICE_PAUSE);
  }
  putDevice(id, subscription, seenAt) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES (?, ?)", id, JSON.stringify({ ...subscription, seenAt }));
  }
  expire(id) {
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM expired WHERE at < ?", Date.now() - 90 * 86_400_000);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO expired VALUES (?, ?)", id, Date.now());
  }
  meta(id) {
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  setMeta(id, value) {
    if (JSON.stringify(this.meta(id)) === JSON.stringify(value ?? null)) return;
    if (value == null) this.ctx.storage.sql.exec("DELETE FROM meta WHERE id = ?", id);
    else this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", id, JSON.stringify(value));
  }

  /** The app user this runner belongs to, so pollers can call back. Runners
   *  are named by user id, so the name answers when the runtime exposes it;
   *  the /tracking routes also say so on every request. */
  userId() {
    const known = this.meta("user");
    if (known) return known;
    const name = this.ctx.id.name;
    if (name) this.setMeta("user", name);
    return name ?? null;
  }
  async identify(userId) {
    if (this.meta("user") === userId) return;
    this.setMeta("user", userId);
    await this.sync(); // a runner that could not subscribe without it can now
  }
  emtAccount() { return this.meta("emt-account"); }

  /** Called whenever the page reads or changes its EMT connection. The stop
   *  pollers use it in their rotation; written only when it changed. */
  async setEmtAccount(account) {
    if ((this.emtAccount()?.connectionId ?? null) === (account?.connectionId ?? null)) return;
    this.setMeta("emt-account", account);
    await this.sync();
  }

  async list() {
    return {
      watches: this.rows("watches").map(({ state, revision, delivered, nextCheck, lastAttempt, ...watch }) => ({
        ...watch,
        lastCheck: Math.max(this.checked.get(watch.id) ?? 0, watch.lastCheck ?? 0) || null,
        // Where a rack stands against the alert rule: the last count and
        // whether alerts are armed.
        ...(watch.kind === "bike" && Number.isInteger(state?.count) ? { rack: { bikes: state.count, armed: state.armed === true } } : {}),
      })),
      devices: this.activeDevices().length,
    };
  }

  async subscribe(subscription) {
    const clean = validateSubscription(subscription);
    const id = await subscriptionId(clean.endpoint);
    if (this.ctx.storage.sql.exec("SELECT 1 FROM expired WHERE id = ?", id).toArray().length) return { id, expired: true };
    const now = Date.now();
    const devices = this.devices();
    const existing = devices.find((d) => d.id === id);
    if (!existing && devices.length >= 5) {
      // A paused device makes room for a new one before the limit bites.
      const [oldest] = devices.filter((d) => d.seenAt != null && now - d.seenAt >= DEVICE_PAUSE)
        .sort((a, b) => a.seenAt - b.seenAt);
      if (!oldest) throw new Error("At most five notification devices are supported");
      this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", oldest.id);
    }
    const { id: _, seenAt, ...stored } = existing ?? {};
    const same = existing && JSON.stringify(stored) === JSON.stringify(clean);
    if (!same || seenAt == null || now - seenAt >= SEEN_WRITE) this.putDevice(id, clean, now);
    await this.sync();
    return { id };
  }

  async unsubscribe(endpoint) {
    const id = await subscriptionId(endpoint);
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    await this.sync();
    return { ok: true };
  }

  async add(input) {
    const watch = validateWatch(input);
    if (!this.activeDevices().length) throw new Error("Enable notifications on this device first");
    const existing = this.watch(watch.id);
    if (existing) {
      // Watches made before notifications carried a location learn it here.
      if (!existing.coordinates && watch.coordinates) this.save({ ...existing, coordinates: watch.coordinates });
      return this.list();
    }
    if (this.rows("watches").length >= 20) throw new Error("At most 20 tracked stops or stations are supported");
    this.save({ ...watch, revision: crypto.randomUUID(), state: {}, lastCheck: null, error: null });
    await this.sync();
    return this.list();
  }

  async remove(id) {
    this.ctx.storage.sql.exec("DELETE FROM watches WHERE id = ?", id);
    await this.sync();
    return this.list();
  }

  /** Subscribe to exactly the pollers this user's watches need, and nothing
   *  when there is no device to notify. Pollers are told only what changed. */
  async sync() {
    const userId = this.userId();
    if (!userId) return; // subscribes once a /tracking request identifies it
    const now = Date.now();
    for (const { id, seenAt, ...subscription } of this.devices()) {
      if (seenAt == null) this.putDevice(id, subscription, now);
      else if (now - seenAt >= DEVICE_FORGET) this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    }
    const watches = this.activeDevices(now).length ? this.rows("watches") : [];
    const account = this.emtAccount();
    const wanted = {
      bikes: [...new Set(watches.filter((w) => w.kind === "bike").map((w) => w.targetId))].sort(),
      stops: [...new Set(watches.filter((w) => w.kind === "bus").map((w) => w.targetId))].sort(),
      connection: account?.connectionId ?? null,
    };
    const current = this.meta("subscriptions") ?? { bikes: [], stops: [], connection: null };
    if (JSON.stringify(current.bikes) !== JSON.stringify(wanted.bikes)) {
      await bikeFeed(this.env).subscribe(userId, wanted.bikes);
    }
    const accountChanged = current.connection !== wanted.connection;
    for (const stop of wanted.stops) {
      if (accountChanged || !current.stops.includes(stop)) await stopPoller(this.env, stop).subscribe(stop, userId, account);
    }
    for (const stop of current.stops) {
      if (!wanted.stops.includes(stop)) await stopPoller(this.env, stop).unsubscribe(userId);
    }
    this.setMeta("subscriptions", wanted);
    // A daily re-sync repairs anything a failed call above left behind, and
    // is what eventually forgets a paused device.
    const alarm = await this.ctx.storage.getAlarm();
    const keep = watches.length > 0 || this.devices().length > 0;
    if (keep && alarm == null) await this.ctx.storage.setAlarm(Date.now() + RESYNC);
    if (!keep && alarm != null) await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    // Runners from before the pollers still hold a 30-second alarm; the first
    // one lands here, subscribes, and is replaced by the daily re-sync.
    this.setMeta("subscriptions", null);
    await this.ctx.storage.deleteAlarm();
    await this.sync();
  }

  /** A bike poll: `payload.stations` maps station id → status, or
   *  `payload.error` when the feed failed. Returns whether this runner still
   *  wants bike counts, so the feed can drop runners that went quiet. */
  async onBikes(payload) {
    if (!this.activeDevices().length) return this.pollerDropped({ bikes: [] });
    const watches = this.rows("watches").filter((w) => w.kind === "bike");
    await Promise.all(watches.map((watch) => this.evaluate(watch, payload.fetchedAt, () => {
      if (payload.error) throw new Error(payload.error);
      const station = payload.stations?.[watch.targetId];
      if (!station || !Number.isInteger(station.bikes) || station.bikes < 0) throw new Error("Station count absent from feed");
      return bikeTransition(watch.state, station);
    })));
    return { active: watches.length > 0 };
  }

  /** A stop's board from its poller, or `payload.error`. */
  async onBoard(stopId, payload) {
    if (!this.activeDevices().length) {
      const stops = this.meta("subscriptions")?.stops ?? [];
      return this.pollerDropped({ stops: stops.filter((stop) => stop !== String(stopId)) });
    }
    const watches = this.rows("watches").filter((w) => w.kind === "bus" && w.targetId === String(stopId));
    await Promise.all(watches.map((watch) => this.evaluate(watch, payload.fetchedAt, () => {
      if (payload.error) throw Object.assign(new Error(payload.error), payload.connect ? { userMessage: payload.error } : {});
      return busTransition(watch.state, payload.arrivals ?? [], watch, payload.fetchedAt);
    })));
    return { active: watches.length > 0 };
  }

  /** Nobody is left to notify: the poller drops this runner when told so.
   *  Record that, so the next check-in's sync() subscribes again. */
  pollerDropped(change) {
    const current = this.meta("subscriptions");
    if (current) this.setMeta("subscriptions", { ...current, ...change });
    return { active: false };
  }

  /** Apply one poll to one watch: send what is news, then persist only what
   *  changed. Never consume an alert until its push has been accepted. */
  async evaluate(watch, polledAt, transition) {
    if (this.busy.has(watch.id)) return;
    this.busy.add(watch.id);
    const now = Number(polledAt) || Date.now();
    try {
      this.checked.set(watch.id, now);
      const result = transition();
      if (this.watch(watch.id)?.revision !== watch.revision) return;
      // A stable notification tag coalesces retries following an ambiguous
      // network failure or a crash after delivery but before the state write.
      let deliveryFailed = false;
      for (const alert of result.alerts) {
        const deliveryKey = alert.vehicle ?? alert.body;
        watch.delivered ??= {};
        watch.delivered[deliveryKey] ??= [];
        for (const device of this.activeDevices(now)) {
          if (watch.delivered[deliveryKey].includes(device.id)) continue;
          if (this.watch(watch.id)?.revision !== watch.revision) break;
          try {
            const status = await sendPush(this.env, device, {
              ...notificationText(watch, alert),
              tag: `${watch.id}:${alert.vehicle ?? "bikes"}`, timestamp: now,
              target: { kind: watch.kind, id: watch.targetId, ...(watch.coordinates ? { coordinates: watch.coordinates } : {}) },
            });
            console.log(JSON.stringify({ event: "push_sent", kind: watch.kind, status }));
            if (status === 404 || status === 410) this.expire(device.id);
            else if (status < 200 || status >= 300) {
              // The push service's status is the whole diagnosis (403: key
              // mismatch, 400: bad payload, 429: throttled). No endpoint logged.
              console.warn(JSON.stringify({ event: "push_rejected", status }));
              deliveryFailed = true;
              continue;
            }
            if (this.watch(watch.id)?.revision === watch.revision) {
              watch.delivered[deliveryKey].push(device.id);
              this.save(watch);
            }
          } catch (error) {
            console.warn(JSON.stringify({ event: "push_error", error: String(error?.message ?? error).slice(0, 200) }));
            deliveryFailed = true;
          }
        }
      }
      if (deliveryFailed) throw new Error("Push delivery incomplete");
      const changed = watch.lastCheck == null || watch.error != null ||
        now - watch.lastCheck >= LAST_CHECK_WRITE ||
        Object.keys(watch.delivered ?? {}).length > 0 ||
        JSON.stringify(result.state) !== JSON.stringify(watch.state ?? {});
      if (changed && this.watch(watch.id)?.revision === watch.revision) {
        this.save({ ...watch, state: result.state, delivered: {}, lastCheck: now, error: null });
      }
    } catch (error) {
      // Never interpret failed/missing data as zero bikes or a bus departure.
      const message = error.userMessage ?? "Check or notification failed; retrying";
      if (watch.error !== message && this.watch(watch.id)?.revision === watch.revision) this.save({ ...watch, error: message });
      console.warn(JSON.stringify({ event: "tracking_retry", kind: watch.kind, error: String(error?.message ?? error).slice(0, 200) }));
    } finally {
      this.busy.delete(watch.id);
    }
  }
}
