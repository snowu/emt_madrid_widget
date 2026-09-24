import { DurableObject } from "cloudflare:workers";
import { getArrivals } from "./emt.js";
import { openCredentials, scopedEnvironment } from "./emt-account.js";
import { getBikeStationStatus } from "./bikes.js";
import { EmtError } from "./errors.js";
import { sendPush, validateSubscription, subscriptionId } from "./push.js";
import { bikeTransition, busTransition, notificationText, BIKE_INTERVAL, BUS_INTERVAL } from "./tracking-rules.js";

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

/** The runner wakes on one aligned 30-second grid for every watch: bikes on
 *  every tick, buses on the first tick of each two-minute slot. */
const TICK = BIKE_INTERVAL;
const BUS_TICKS = BUS_INTERVAL / BIKE_INTERVAL;
const nextTick = (now) => (Math.floor(now / TICK) + 1) * TICK;

// One object per authenticated user. Watches are shared by that user's devices;
// browser subscriptions and mutable alert history never leave this object.
//
// Storage writes are the scarce resource: the free plan allows 100k rows
// written a day, and every setAlarm() is one. Each watch used to keep its own
// next-check time, so the object woke once per watch per interval and wrote
// that time, the result and two alarms on every wake — about 160k writes a
// day for 14 racks. Now there is one wake per tick, one alarm write per tick,
// and a watch row is written only when its state, error or delivery record
// actually changes. When it was last checked lives in memory.
export class TrackingRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Subscriptions the push service answered 404/410 for. A browser keeps
    // handing back its dead subscription, so without this list re-enabling
    // re-registered it, the next send dropped it again, and checks stopped.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS expired (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // The user's EMT connection (ciphertext only), so bus checks spend their
    // quota rather than the shared login's. One row, written when it changes.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.checked = new Map(); // watch id → last check, deliberately not persisted
  }

  rows(table) { return this.ctx.storage.sql.exec(`SELECT id, value FROM ${table}`).toArray().map((r) => ({ id: r.id, ...JSON.parse(r.value) })); }
  watch(id) { const row = this.ctx.storage.sql.exec("SELECT value FROM watches WHERE id = ?", id).toArray()[0]; return row ? JSON.parse(row.value) : null; }
  save(watch) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO watches VALUES (?, ?)", watch.id, JSON.stringify(watch)); }
  devices() { return this.rows("devices"); }
  expire(id) {
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    this.ctx.storage.sql.exec("DELETE FROM expired WHERE at < ?", Date.now() - 90 * 86_400_000);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO expired VALUES (?, ?)", id, Date.now());
  }

  /** A watch never checked goes at once. Otherwise bikes go every tick and
   *  buses on the first tick of a two-minute slot — worked out from the
   *  clock, so an evicted object that lost its memory still keeps the bus
   *  cadence instead of polling EMT every 30 seconds. */
  isDue(watch, now) {
    const last = this.checked.get(watch.id) ?? watch.lastCheck;
    if (last == null || this.dueOverride) return true;
    if (watch.kind === "bike") return now - last >= TICK - 5_000;
    return Math.floor(now / TICK) % BUS_TICKS === 0 && now - last >= BUS_INTERVAL - TICK;
  }

  emtAccount() {
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE id = 'emt-account'").toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  /** Called whenever the page reads or changes its EMT connection. Written
   *  only when the connection actually changed. */
  async setEmtAccount(account) {
    const current = this.emtAccount();
    if ((current?.connectionId ?? null) === (account?.connectionId ?? null)) return;
    if (account) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES ('emt-account', ?)", JSON.stringify(account));
    else this.ctx.storage.sql.exec("DELETE FROM meta WHERE id = 'emt-account'");
    this.emtEnv = null;
  }

  /** The env bus checks run with: the user's EMT login if they connected
   *  one, the shared login otherwise. */
  async checkEnv() {
    if (this.emtEnv) return this.emtEnv;
    const account = this.emtAccount();
    if (!account) return this.env;
    const credentials = await openCredentials(this.env, account.userId, account.credentials);
    this.emtEnv = scopedEnvironment(this.env, credentials, `${account.userId}:${account.connectionId}`);
    return this.emtEnv;
  }

  async list() {
    return {
      watches: this.rows("watches").map(({ state, revision, delivered, nextCheck, lastAttempt, ...watch }) => ({
        ...watch,
        lastCheck: this.checked.get(watch.id) ?? watch.lastCheck ?? null,
        // A rack only alerts after it has been seen empty, so the page shows
        // where it stands: the last count and whether that has happened.
        ...(watch.kind === "bike" && Number.isInteger(state?.count) ? { rack: { bikes: state.count, armed: state.armed === true } } : {}),
      })),
      devices: this.devices().length,
    };
  }

  async subscribe(subscription) {
    const clean = validateSubscription(subscription);
    const id = await subscriptionId(clean.endpoint);
    if (this.ctx.storage.sql.exec("SELECT 1 FROM expired WHERE id = ?", id).toArray().length) return { id, expired: true };
    if (!this.devices().some((d) => d.id === id) && this.devices().length >= 5) throw new Error("At most five notification devices are supported");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES (?, ?)", id, JSON.stringify(clean));
    await this.schedule();
    return { id };
  }

  async unsubscribe(endpoint) {
    const id = await subscriptionId(endpoint);
    this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", id);
    await this.schedule();
    return { ok: true };
  }

  async add(input) {
    const watch = validateWatch(input);
    if (!this.devices().length) throw new Error("Enable notifications on this device first");
    const existing = this.watch(watch.id);
    if (existing) {
      // Watches made before notifications carried a location learn it here.
      if (!existing.coordinates && watch.coordinates) this.save({ ...existing, coordinates: watch.coordinates });
      return this.list();
    }
    if (this.rows("watches").length >= 20) throw new Error("At most 20 tracked stops or stations are supported");
    this.save({ ...watch, revision: crypto.randomUUID(), state: {}, lastCheck: null, error: null });
    await this.schedule();
    return this.list();
  }

  async remove(id) {
    this.ctx.storage.sql.exec("DELETE FROM watches WHERE id = ?", id);
    await this.schedule();
    return this.list();
  }

  /** Make sure a wake-up is pending while there is work, and none when there
   *  is not. An existing alarm is left alone: rewriting it costs a write. */
  async schedule() {
    const current = await this.ctx.storage.getAlarm();
    if (!this.rows("watches").length || !this.devices().length) {
      if (current != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  async alarm() {
    const now = Date.now();
    const watches = this.rows("watches");
    if (!watches.length || !this.devices().length) return;
    // The next tick is booked before any I/O, so an outage or a terminated
    // handler cannot strand the runner. This is the only per-tick write.
    await this.ctx.storage.setAlarm(nextTick(now));
    const due = watches.filter((watch) => this.isDue(watch, now));
    let bikes;
    const boards = new Map();
    for (const watch of due) {
      this.checked.set(watch.id, now);
      try {
        let result;
        if (watch.kind === "bike") {
          bikes ??= getBikeStationStatus({ forTracking: true }); // deliberately bypass the UI's 45s cache
          const payload = await bikes;
          const station = payload.status.find((s) => s.id === watch.targetId);
          if (!station || !Number.isInteger(station.bikes) || station.bikes < 0) throw new Error("Station count absent from feed");
          result = bikeTransition(watch.state, station);
        } else {
          if (!boards.has(watch.targetId)) boards.set(watch.targetId, this.checkEnv().then((env) => getArrivals(env, watch.targetId, "tracking")));
          const payload = await boards.get(watch.targetId);
          result = busTransition(watch.state, payload.arrivals, watch, now);
        }
        if (this.watch(watch.id)?.revision !== watch.revision) continue;
        // A stable notification tag coalesces retries following an ambiguous
        // network failure or a crash after delivery but before the state write.
        let deliveryFailed = false;
        for (const alert of result.alerts) {
          const deliveryKey = alert.vehicle ?? alert.body;
          watch.delivered ??= {};
          watch.delivered[deliveryKey] ??= [];
          for (const device of this.devices()) {
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
          Object.keys(watch.delivered ?? {}).length > 0 ||
          JSON.stringify(result.state) !== JSON.stringify(watch.state ?? {});
        if (changed && this.watch(watch.id)?.revision === watch.revision) {
          this.save({ ...watch, state: result.state, delivered: {}, lastCheck: now, error: null });
        }
      } catch (error) {
        // Never interpret failed/missing data as zero bikes or a bus departure.
        const message = "Check or notification failed; retrying";
        if (watch.error !== message && this.watch(watch.id)?.revision === watch.revision) this.save({ ...watch, error: message });
        console.warn(JSON.stringify({ event: "tracking_retry", kind: watch.kind, error: String(error?.message ?? error).slice(0, 200) }));
      }
    }
    // Every device expired during this tick: nothing left to notify.
    if (!this.devices().length) await this.ctx.storage.deleteAlarm();
  }
}
