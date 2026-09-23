import { DurableObject } from "cloudflare:workers";
import { getArrivals } from "./emt.js";
import { getBikeStationStatus } from "./bikes.js";
import { EmtError } from "./errors.js";
import { sendPush, validateSubscription, subscriptionId } from "./push.js";
import { bikeTransition, busTransition, BIKE_INTERVAL, BUS_INTERVAL } from "./tracking-rules.js";

export function validateWatch(input) {
  if (!input || !["bus", "bike"].includes(input.kind) || !/^\d{1,8}$/.test(input.targetId ?? "")) {
    throw new EmtError("bad_request", "Choose a bus stop or bike station");
  }
  const line = String(input.line ?? "").trim().toUpperCase();
  if (input.kind === "bus" && !/^[A-Z0-9]{1,8}$/.test(line)) throw new EmtError("bad_request", "Choose a bus line");
  const destination = typeof input.destination === "string" ? input.destination.trim().slice(0, 160) : "";
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 120) : "";
  const watch = { kind: input.kind, targetId: String(input.targetId), label, line: input.kind === "bus" ? line : "", destination: input.kind === "bus" ? destination : "" };
  return { ...watch, id: JSON.stringify([watch.kind, watch.targetId, watch.line, watch.destination]) };
}

// One object per authenticated user. Watches are shared by that user's devices;
// browser subscriptions and mutable alert history never leave this object.
export class TrackingRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  rows(table) { return this.ctx.storage.sql.exec(`SELECT id, value FROM ${table}`).toArray().map((r) => ({ id: r.id, ...JSON.parse(r.value) })); }
  watch(id) { const row = this.ctx.storage.sql.exec("SELECT value FROM watches WHERE id = ?", id).toArray()[0]; return row ? JSON.parse(row.value) : null; }
  save(watch) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO watches VALUES (?, ?)", watch.id, JSON.stringify(watch)); }
  devices() { return this.rows("devices"); }

  async list() {
    return { watches: this.rows("watches").map(({ state, revision, delivered, ...watch }) => watch), devices: this.devices().length };
  }

  async subscribe(subscription) {
    const clean = validateSubscription(subscription);
    const id = await subscriptionId(clean.endpoint);
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
    if (this.watch(watch.id)) return this.list();
    if (this.rows("watches").length >= 20) throw new Error("At most 20 tracked stops or stations are supported");
    this.save({ ...watch, revision: crypto.randomUUID(), state: {}, nextCheck: Date.now(), lastCheck: null, error: null });
    await this.schedule();
    return this.list();
  }

  async remove(id) {
    this.ctx.storage.sql.exec("DELETE FROM watches WHERE id = ?", id);
    await this.schedule();
    return this.list();
  }

  async schedule() {
    const watches = this.rows("watches");
    if (!watches.length || !this.devices().length) return this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...watches.map((w) => w.nextCheck))));
  }

  async alarm() {
    if (!this.devices().length) return;
    const now = Date.now();
    const due = this.rows("watches").filter((w) => w.nextCheck <= now);
    // Persist the next wake-up before external I/O. Even a terminated handler
    // or an upstream outage must not strand the runner.
    for (const watch of due) {
      watch.nextCheck = now + (watch.kind === "bike" ? BIKE_INTERVAL : BUS_INTERVAL);
      this.save(watch);
    }
    await this.schedule();
    let bikes;
    const boards = new Map();
    for (const watch of due) {
      try {
        let result;
        if (watch.kind === "bike") {
          bikes ??= getBikeStationStatus({ forTracking: true }); // deliberately bypass the UI's 45s cache
          const payload = await bikes;
          const station = payload.status.find((s) => s.id === watch.targetId);
          if (!station || !Number.isInteger(station.bikes) || station.bikes < 0) throw new Error("Station count absent from feed");
          result = bikeTransition(watch.state, station);
        } else {
          if (!boards.has(watch.targetId)) boards.set(watch.targetId, getArrivals(this.env, watch.targetId, "tracking"));
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
              // The collapsed Android shade shows little more than the title,
              // so it carries the news and the body says where.
              const place = `${watch.kind === "bike" ? "Station" : "Stop"} ${watch.targetId}`;
              const status = await sendPush(this.env, device, {
                title: alert.headline ?? alert.body,
                body: watch.label ? `${watch.label} · ${place}` : place,
                tag: `${watch.id}:${alert.vehicle ?? "bikes"}`, timestamp: now,
                target: { kind: watch.kind, id: watch.targetId },
              });
              if (status === 404 || status === 410) this.ctx.storage.sql.exec("DELETE FROM devices WHERE id = ?", device.id);
              else if (status < 200 || status >= 300) { deliveryFailed = true; continue; }
              if (this.watch(watch.id)?.revision === watch.revision) {
                watch.delivered[deliveryKey].push(device.id);
                this.save(watch);
              }
            } catch { deliveryFailed = true; }
          }
        }
        if (deliveryFailed) throw new Error("Push delivery incomplete");
        if (this.watch(watch.id)?.revision === watch.revision) this.save({ ...watch, state: result.state, delivered: {}, lastCheck: Date.now(), error: null });
      } catch {
        // Never interpret failed/missing data as zero bikes or a bus departure.
        if (this.watch(watch.id)?.revision === watch.revision) this.save({ ...watch, error: "Check or notification failed; retrying", lastAttempt: Date.now() });
        console.warn(JSON.stringify({ event: "tracking_retry", kind: watch.kind }));
      }
    }
    await this.schedule();
  }
}
