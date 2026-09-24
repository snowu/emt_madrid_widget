import { DurableObject } from "cloudflare:workers";
import { getArrivals } from "./emt.js";
import { getBikeStationStatus } from "./bikes.js";
import { openCredentials, scopedEnvironment, sharedLoginIsOwners } from "./emt-account.js";
import { EmtError } from "./errors.js";
import { BIKE_INTERVAL, BUS_INTERVAL } from "./tracking-rules.js";

/* Shared pollers: fetch once, notify every user who tracks it.
 *
 * Tracking used to run inside each user's TrackingRunner, so two people on the
 * same stop cost two EMT calls per check and every runner woke (and wrote an
 * alarm) on its own. Here one object per bus stop, and one for the whole bike
 * network, does the fetching on an aligned clock and calls each subscribed
 * runner with the result. Runners keep the per-user part: alert rules, devices,
 * delivery.
 *
 * A stop poller spends the EMT quota of the users watching that stop, taking
 * turns between those who connected their own account; if the chosen account
 * fails it tries the others, so one user's broken connection never silences
 * everybody else's alerts. The shared login is the last resort, and with
 * EMT_SHARED_LOGIN = "owner" only when the owner is one of the watchers.
 */

// get(idFromName()) is getByName() spelled for older runtimes too.
const named = (namespace, name) => namespace.get(namespace.idFromName(name));
export const bikeFeed = (env) => named(env.BIKE_FEED, "city");
export const stopPoller = (env, stopId) => named(env.STOP_POLLER, String(stopId));
const runner = (env, userId) => named(env.TRACKING, userId);
const nextSlot = (now, every) => (Math.floor(now / every) + 1) * every;

class Poller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS subscribers (user TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  subscribers() {
    return this.ctx.storage.sql.exec("SELECT user, value FROM subscribers").toArray()
      .map((row) => ({ user: row.user, ...JSON.parse(row.value) }));
  }

  /** Store a subscriber only if it changed, and make sure a poll is coming:
   *  a new subscriber should hear something within one interval. */
  async put(user, value) {
    const row = this.ctx.storage.sql.exec("SELECT value FROM subscribers WHERE user = ?", user).toArray()[0];
    if (row?.value !== JSON.stringify(value)) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO subscribers VALUES (?, ?)", user, JSON.stringify(value));
    }
    // Tests set a long delay and run polls explicitly: an alarm firing on its
    // own mid-test races the test's own calls and its storage reset.
    const delay = Number(this.env.POLLER_START_DELAY_MS ?? 100);
    if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  drop(user) {
    this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE user = ?", user);
  }

  /** Hand one poll to every subscriber in parallel. A runner that has nothing
   *  left to watch here says so and is dropped. */
  async fanOut(call) {
    const subscribers = this.subscribers();
    const answers = await Promise.allSettled(subscribers.map((s) => call(runner(this.env, s.user), s)));
    answers.forEach((answer, index) => {
      if (answer.status === "fulfilled" && answer.value?.active === false) this.drop(subscribers[index].user);
    });
  }
}

/** The whole BiciMAD network, polled every 30 seconds for everyone. */
export class BikeFeed extends Poller {
  async subscribe(user, stations) {
    if (!stations.length) return this.drop(user);
    await this.put(user, { stations });
  }

  async alarm() {
    if (!this.subscribers().length) return; // nobody left: stop polling
    const now = Date.now();
    await this.ctx.storage.setAlarm(nextSlot(now, BIKE_INTERVAL));
    let status;
    try {
      // Deliberately bypasses the page's 45 s cache, and refuses a stale feed.
      status = await getBikeStationStatus({ forTracking: true });
    } catch (error) {
      await this.fanOut((stub) => stub.onBikes({ error: String(error?.message ?? error), fetchedAt: now }));
      return;
    }
    // Each runner gets only the stations it tracks, not the whole city.
    const byId = new Map(status.status.map((s) => [s.id, s]));
    await this.fanOut((stub, subscriber) => {
      const stations = {};
      for (const id of subscriber.stations ?? []) if (byId.has(id)) stations[id] = byId.get(id);
      return stub.onBikes({ stations, fetchedAt: status.fetchedAt });
    });
  }
}

/** One bus stop, polled every two minutes for everyone watching it. */
export class StopPoller extends Poller {
  async subscribe(stopId, user, account) {
    const known = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE id = 'stop'").toArray()[0];
    if (!known) this.ctx.storage.sql.exec("INSERT INTO meta VALUES ('stop', ?)", JSON.stringify(String(stopId)));
    // Only the ciphertext, and only for users who connected an EMT account.
    await this.put(user, { account: account ? { userId: account.userId, connectionId: account.connectionId, credentials: account.credentials } : null });
  }

  async unsubscribe(user) { this.drop(user); }

  stopId() {
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE id = 'stop'").toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  /** Whose quota this poll may spend, in the order to try: the connected
   *  watchers in turn (one starts each two-minute slot), then the shared
   *  login if this stop is allowed it. */
  async environments(now) {
    const subscribers = this.subscribers();
    const accounts = subscribers.map((s) => s.account).filter(Boolean)
      .sort((a, b) => a.userId.localeCompare(b.userId));
    const start = accounts.length ? Math.floor(now / BUS_INTERVAL) % accounts.length : 0;
    const ordered = [...accounts.slice(start), ...accounts.slice(0, start)];
    const envs = [];
    for (const account of ordered) {
      try {
        const credentials = await openCredentials(this.env, account.userId, account.credentials);
        envs.push(scopedEnvironment(this.env, credentials, `${account.userId}:${account.connectionId}`));
      } catch { /* undecryptable: skip this watcher's account */ }
    }
    const ownerWatches = subscribers.some((s) => this.env.OWNER_USER_ID && s.user === this.env.OWNER_USER_ID);
    if (!sharedLoginIsOwners(this.env) || ownerWatches) envs.push(this.env);
    return envs;
  }

  async alarm() {
    const stopId = this.stopId();
    if (!stopId || !this.subscribers().length) return;
    const now = Date.now();
    await this.ctx.storage.setAlarm(nextSlot(now, BUS_INTERVAL));
    let payload;
    let lastError;
    // The chosen account first; if EMT refuses it (rejected, out of quota),
    // the shared login keeps everybody's alerts going this slot.
    for (const env of await this.environments(now)) {
      try {
        const board = await getArrivals(env, stopId, "tracking");
        payload = { arrivals: board.arrivals, fetchedAt: board.fetchedAt ?? now };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    payload ??= lastError
      ? { error: String(lastError?.message ?? lastError), fetchedAt: now }
      // Nobody here may spend any quota: tell the runners why.
      : { error: new EmtError("emt_account", "Connect your EMT account to keep bus alerts").message, connect: true, fetchedAt: now };
    await this.fanOut((stub) => stub.onBoard(stopId, payload));
  }
}
