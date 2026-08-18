# EMT Madrid Arrivals Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-home-screen webpage showing live EMT Madrid bus arrivals for saved stops, with stops shared across devices.

**Architecture:** A static page on GitHub Pages calls a Cloudflare Worker. The worker holds every secret (EMT credentials, Supabase service key), caches the EMT token in KV, caches arrivals for 20s, and proxies to EMT and Supabase. The page holds nothing secret and uses localStorage only as a per-device cache of last-known arrivals.

**Tech Stack:** Cloudflare Workers (JS modules, `wrangler`, `vitest` via `@cloudflare/vitest-pool-workers`), Supabase Postgres over plain REST, vanilla HTML/CSS/JS on the page (no framework, no build step).

**Spec:** `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`

## Global Constraints

- **The page never calls EMT or Supabase directly.** Browser JS keeps no secrets and EMT sends no CORS headers. Every outbound call goes through the worker.
- **Secrets live only in worker env:** `EMT_EMAIL`, `EMT_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `APP_KEY`. Never in `web/`, never committed. `.dev.vars` is gitignored.
- **EMT signals failure as a `code` field inside a 200 response**, not as an HTTP status. Every EMT call checks `code` as well as `response.ok`.
- EMT codes: `01` login ok, `89` bad password, `92` no such user, `98` quota exceeded, `00` arrivals ok, `80` stop not found / invalid token.
- **Arrival field names** (verified against `fermartv/EMTMadrid`): arrivals live at `data[0].Arrive[]`; per bus, `line` (string), `estimateArrive` (seconds), `DistanceBus` (capital D, metres).
- **Tests use recorded fixtures, never live EMT calls** — tests must not burn quota.
- Two arrivals shown per stop.
- Supabase table `bus_stops` has RLS enabled with **zero policies**: reachable only via the service-role key, i.e. only from the worker.
- No build step for `web/`. Plain files served as-is by GitHub Pages.

---

## File Structure

```
api/
  src/
    index.js          route dispatch + CORS. The only export default.
    emt.js            EMT login, token cache, arrivals fetch + parse.
    stops.js          Supabase CRUD over plain REST.
    errors.js         error → HTTP response mapping, shared vocabulary.
  test/
    fixtures/         recorded EMT + Supabase JSON
    emt.test.js
    stops.test.js
    index.test.js
  wrangler.toml
  package.json
  .dev.vars.example

web/
  index.html
  app.js            fetch + render + countdown loop
  cache.js          localStorage read/write of last-known arrivals
  style.css

supabase/
  bus_stops.sql

README.md           note explaining the repo name
```

Split rationale: `emt.js` and `stops.js` talk to different upstreams with different failure modes and different auth, so they are separately testable units. `errors.js` exists so the page receives one consistent error vocabulary no matter which upstream failed.

---

### Task 1: Repo scaffolding and Supabase schema

**Files:**
- Create: `api/package.json`, `api/wrangler.toml`, `api/.dev.vars.example`, `supabase/bus_stops.sql`, `.gitignore`, `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a `wrangler dev`-able worker skeleton and the `bus_stops` table definition. Later tasks assume env vars `EMT_EMAIL`, `EMT_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `APP_KEY`, and a KV binding named `KV`.

- [ ] **Step 1: Create the gitignore**

```bash
cat > .gitignore <<'EOF'
node_modules/
.dev.vars
.env
.wrangler/
EOF
```

- [ ] **Step 2: Write the Supabase schema**

Create `supabase/bus_stops.sql`:

```sql
-- Run once in the Supabase SQL editor.
-- No policies: RLS on with zero policies means only the service-role key
-- can read or write this table. The worker holds that key; the page never
-- talks to Supabase directly.
create table if not exists bus_stops (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null check (stop_id ~ '^[0-9]+$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists bus_stops_stop_id_key on bus_stops (stop_id);

alter table bus_stops enable row level security;
```

- [ ] **Step 3: Create the worker package**

Create `api/package.json`:

```json
{
  "name": "emt-arrivals-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.60.0"
  }
}
```

- [ ] **Step 4: Create the wrangler config**

Create `api/wrangler.toml`. Replace `<kv-id>` after running the KV create command in Step 6.

```toml
name = "emt-arrivals"
main = "src/index.js"
compatibility_date = "2026-08-18"

kv_namespaces = [
  { binding = "KV", id = "<kv-id>" }
]

[vars]
# Secrets are NOT here. Set them with `wrangler secret put <NAME>`,
# or locally in .dev.vars (gitignored).
ALLOWED_ORIGIN = "https://snowu.github.io"
```

Create `api/.dev.vars.example`:

```
EMT_EMAIL=you@example.com
EMT_PASSWORD=
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=
APP_KEY=any-random-string
```

- [ ] **Step 5: Create the vitest config**

Create `api/vitest.config.js`:

```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 6: Install and create the KV namespace**

```bash
cd api && npm install
npx wrangler kv namespace create KV
```

Paste the returned id into `wrangler.toml`. This requires a Cloudflare login (`npx wrangler login`) — if that is not available yet, put `id = "placeholder"` and note that `npm test` works regardless, since the test pool provides its own KV.

- [ ] **Step 7: Write the README**

Create `README.md`:

```markdown
# EMT Madrid Arrivals

Live EMT Madrid bus arrival times for a handful of saved stops. A webpage,
opened from a phone home screen.

**The repo is named `emt_madrid_widget` and there is no widget.** This started
as an Android home screen widget and became a webpage; the name was kept to
avoid churn.

- `web/` — static page, deployed to GitHub Pages. Holds no secrets.
- `api/` — Cloudflare Worker. Holds EMT credentials and the Supabase service key.
- `supabase/` — table definition.

Design: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`

Bus data from [EMT MobilityLabs](https://mobilitylabs.emtmadrid.es).
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold worker, Supabase schema, and README"
```

---

### Task 2: EMT login and token caching

**Files:**
- Create: `api/src/errors.js`, `api/src/emt.js`, `api/test/emt.test.js`, `api/test/fixtures/login-ok.json`, `api/test/fixtures/login-bad-password.json`

**Interfaces:**
- Consumes: env `EMT_EMAIL`, `EMT_PASSWORD`; KV binding `KV`.
- Produces:
  - `class EmtError extends Error` with `.kind` (one of `"auth"`, `"quota"`, `"not_found"`, `"upstream"`) — from `errors.js`.
  - `async function getToken(env, { force = false } = {}) -> string` — from `emt.js`. Reads KV key `emt:token`, logs in when missing/expired/`force`.

- [ ] **Step 1: Write the error vocabulary**

Create `api/src/errors.js`:

```js
/** One vocabulary of failure kinds, so the page sees consistent errors
 *  whichever upstream broke. */
export class EmtError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "EmtError";
    this.kind = kind; // "auth" | "quota" | "not_found" | "upstream"
  }
}

const STATUS_BY_KIND = {
  auth: 502,      // our credentials are wrong; not the caller's fault
  quota: 503,     // resolves at the daily reset
  not_found: 404,
  upstream: 502,
};

export function errorResponse(err, headers = {}) {
  const kind = err instanceof EmtError ? err.kind : "upstream";
  const status = STATUS_BY_KIND[kind] ?? 502;
  return new Response(JSON.stringify({ error: kind, message: err.message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
```

- [ ] **Step 2: Record the login fixtures**

Create `api/test/fixtures/login-ok.json`:

```json
{
  "code": "01",
  "description": "Token 24 hours",
  "data": [
    {
      "accessToken": "fake-token-abc123",
      "tokenSecExpiration": 86400
    }
  ]
}
```

Create `api/test/fixtures/login-bad-password.json`:

```json
{
  "code": "89",
  "description": "Password incorrect",
  "data": []
}
```

- [ ] **Step 3: Write the failing tests**

Create `api/test/emt.test.js`:

```js
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getToken } from "../src/emt.js";
import { EmtError } from "../src/errors.js";
import loginOk from "./fixtures/login-ok.json";
import loginBadPassword from "./fixtures/login-bad-password.json";

function mockFetchOnce(body, init = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, ...init })
  );
}

describe("getToken", () => {
  beforeEach(async () => {
    await env.KV.delete("emt:token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs in and returns the access token", async () => {
    mockFetchOnce(loginOk);
    const token = await getToken(env);
    expect(token).toBe("fake-token-abc123");
  });

  it("sends credentials as headers, not as a body", async () => {
    const spy = mockFetchOnce(loginOk);
    await getToken(env);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v1/mobilitylabs/user/login/");
    expect(init.method).toBe("GET");
    expect(init.headers.email).toBe(env.EMT_EMAIL);
    expect(init.headers.password).toBe(env.EMT_PASSWORD);
    expect(init.body).toBeUndefined();
  });

  it("caches the token in KV so a second call makes no request", async () => {
    const spy = mockFetchOnce(loginOk);
    await getToken(env);
    await getToken(env);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-logs in when force is set, even with a cached token", async () => {
    const spy = mockFetchOnce(loginOk);
    await getToken(env);
    await getToken(env, { force: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws an auth error on code 89, a 200 response", async () => {
    mockFetchOnce(loginBadPassword);
    await expect(getToken(env)).rejects.toMatchObject({
      name: "EmtError",
      kind: "auth",
    });
  });

  it("throws a quota error on code 98", async () => {
    mockFetchOnce({ code: "98", description: "limit", data: [] });
    await expect(getToken(env)).rejects.toMatchObject({ kind: "quota" });
  });

  it("throws an upstream error on a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("gateway timeout", { status: 504 })
    );
    await expect(getToken(env)).rejects.toMatchObject({ kind: "upstream" });
  });
});
```

- [ ] **Step 4: Add test env vars**

Add to `api/wrangler.toml` under `[vars]` so `cloudflare:test` supplies them:

```toml
EMT_EMAIL = "test@example.com"
EMT_PASSWORD = "test-password"
APP_KEY = "test-app-key"
```

These are test placeholders. Real values go in `.dev.vars` locally and via `wrangler secret put` in production, both of which override `[vars]`.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd api && npm test`
Expected: FAIL — `Cannot find module '../src/emt.js'`.

- [ ] **Step 6: Implement the EMT client**

Create `api/src/emt.js`:

```js
import { EmtError } from "./errors.js";

const BASE = "https://openapi.emtmadrid.es/";
const TOKEN_KEY = "emt:token";

// EMT reports failure as a `code` inside a 200 response, not as an HTTP status.
const CODE_KIND = {
  "89": ["auth", "invalid EMT password"],
  "92": ["auth", "EMT user does not exist"],
  "98": ["quota", "EMT daily API quota exceeded"],
  "80": ["not_found", "stop not found or token invalid"],
};

function raiseForCode(code) {
  const known = CODE_KIND[String(code)];
  if (known) throw new EmtError(known[0], known[1]);
  throw new EmtError("upstream", `unexpected EMT code ${code}`);
}

async function login(env) {
  let res;
  try {
    res = await fetch(`${BASE}v1/mobilitylabs/user/login/`, {
      method: "GET",
      headers: { email: env.EMT_EMAIL, password: env.EMT_PASSWORD },
    });
  } catch (cause) {
    throw new EmtError("upstream", `EMT unreachable: ${cause.message}`);
  }

  if (!res.ok) {
    throw new EmtError("upstream", `EMT login HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.code !== "01") raiseForCode(body.code);

  const entry = body.data?.[0];
  if (!entry?.accessToken) {
    throw new EmtError("upstream", "EMT login returned no accessToken");
  }
  return {
    token: entry.accessToken,
    // Expire ours a minute early so we never present a token mid-expiry.
    ttl: Math.max(60, Number(entry.tokenSecExpiration ?? 86400) - 60),
  };
}

/** Return a usable EMT access token, logging in only when needed. */
export async function getToken(env, { force = false } = {}) {
  if (!force) {
    const cached = await env.KV.get(TOKEN_KEY);
    if (cached) return cached;
  }
  const { token, ttl } = await login(env);
  await env.KV.put(TOKEN_KEY, token, { expirationTtl: ttl });
  return token;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd api && npm test`
Expected: PASS — 7 tests in `emt.test.js`.

- [ ] **Step 8: Commit**

```bash
git add api/src/errors.js api/src/emt.js api/test/ api/wrangler.toml
git commit -m "feat: EMT login with KV-cached token"
```

---

### Task 3: EMT arrivals fetch and parse

**Files:**
- Modify: `api/src/emt.js`
- Modify: `api/test/emt.test.js`
- Create: `api/test/fixtures/arrivals-ok.json`, `api/test/fixtures/arrivals-empty.json`

**Interfaces:**
- Consumes: `getToken(env, opts)` and `EmtError` from Task 2.
- Produces: `async function getArrivals(env, stopId) -> { stopId, arrivals: Array<{line: string, seconds: number, metres: number|null}>, fetchedAt: number }`. `arrivals` is sorted soonest-first and capped at 2.

- [ ] **Step 1: Record the arrivals fixtures**

Create `api/test/fixtures/arrivals-ok.json`. Field names verified against `fermartv/EMTMadrid`: arrivals live at `data[0].Arrive[]`, and `DistanceBus` carries a capital D. Deliberately unsorted, with a third bus, to exercise sorting and the cap.

```json
{
  "code": "00",
  "description": "Data recovered OK",
  "data": [
    {
      "Arrive": [
        {
          "line": "27",
          "stop": "1234",
          "bus": 4821,
          "destination": "PLAZA CASTILLA",
          "estimateArrive": 640,
          "DistanceBus": 3120,
          "isHead": "False",
          "geometry": { "type": "Point", "coordinates": [-3.6903, 40.4501] }
        },
        {
          "line": "27",
          "stop": "1234",
          "bus": 4802,
          "destination": "PLAZA CASTILLA",
          "estimateArrive": 145,
          "DistanceBus": 610,
          "isHead": "True",
          "geometry": { "type": "Point", "coordinates": [-3.6899, 40.4477] }
        },
        {
          "line": "150",
          "stop": "1234",
          "bus": 5510,
          "destination": "MONCLOA",
          "estimateArrive": 1980,
          "DistanceBus": 8400,
          "isHead": "False",
          "geometry": { "type": "Point", "coordinates": [-3.7011, 40.4402] }
        }
      ]
    }
  ]
}
```

Create `api/test/fixtures/arrivals-empty.json` — a real stop with nothing due:

```json
{
  "code": "00",
  "description": "Data recovered OK",
  "data": [{ "Arrive": [] }]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `api/test/emt.test.js`:

```js
import { getArrivals } from "../src/emt.js";
import arrivalsOk from "./fixtures/arrivals-ok.json";
import arrivalsEmpty from "./fixtures/arrivals-empty.json";

describe("getArrivals", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses line, seconds, and metres from data[0].Arrive[]", async () => {
    mockFetchOnce(arrivalsOk);
    const result = await getArrivals(env, "1234");
    expect(result.arrivals[0]).toEqual({ line: "27", seconds: 145, metres: 610 });
  });

  it("sorts soonest-first and returns at most two", async () => {
    mockFetchOnce(arrivalsOk);
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals.map((a) => a.seconds)).toEqual([145, 640]);
  });

  it("stamps fetchedAt so the page can show staleness", async () => {
    mockFetchOnce(arrivalsOk);
    const before = Date.now();
    const { fetchedAt } = await getArrivals(env, "1234");
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("posts stopId and the estimations flag in the body", async () => {
    const spy = mockFetchOnce(arrivalsOk);
    await getArrivals(env, "1234");
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v2/transport/busemtmad/stops/1234/arrives/");
    expect(init.method).toBe("POST");
    expect(init.headers.accessToken).toBe("cached-token");
    expect(JSON.parse(init.body)).toEqual({
      stopId: "1234",
      Text_EstimationsRequired_YN: "Y",
    });
  });

  it("returns an empty list, not an error, when nothing is due", async () => {
    mockFetchOnce(arrivalsEmpty);
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals).toEqual([]);
  });

  it("re-logs in once and retries when the token is rejected with code 80", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify(arrivalsOk)));

    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up with not_found after one failed retry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })));

    await expect(getArrivals(env, "9999")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("tolerates a missing DistanceBus", async () => {
    mockFetchOnce({
      code: "00",
      data: [{ Arrive: [{ line: "27", estimateArrive: 100 }] }],
    });
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals[0]).toEqual({ line: "27", seconds: 100, metres: null });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && npm test`
Expected: FAIL — `getArrivals is not a function`.

- [ ] **Step 4: Implement arrivals fetching**

Append to `api/src/emt.js`:

```js
const MAX_ARRIVALS = 2;

async function requestArrivals(env, stopId, token) {
  let res;
  try {
    res = await fetch(`${BASE}v2/transport/busemtmad/stops/${stopId}/arrives/`, {
      method: "POST",
      headers: { accessToken: token, "content-type": "application/json" },
      body: JSON.stringify({
        stopId: String(stopId),
        Text_EstimationsRequired_YN: "Y",
      }),
    });
  } catch (cause) {
    throw new EmtError("upstream", `EMT unreachable: ${cause.message}`);
  }
  if (!res.ok) throw new EmtError("upstream", `EMT arrivals HTTP ${res.status}`);
  return res.json();
}

function parseArrivals(body) {
  // Arrivals live at data[0].Arrive[]. Capital D in DistanceBus is EMT's, not a typo.
  const raw = body.data?.[0]?.Arrive ?? [];
  return raw
    .filter((a) => a.line != null && a.estimateArrive != null)
    .map((a) => ({
      line: String(a.line),
      seconds: Number(a.estimateArrive),
      metres: a.DistanceBus == null ? null : Number(a.DistanceBus),
    }))
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, MAX_ARRIVALS);
}

/** Fetch the next arrivals for one stop, re-logging in once if the token is stale. */
export async function getArrivals(env, stopId) {
  let token = await getToken(env);
  let body = await requestArrivals(env, stopId, token);

  // Code 80 is both "stop not found" and "invalid token" — indistinguishable
  // here, so retry once with a fresh token before believing the stop is bad.
  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestArrivals(env, stopId, token);
  }

  if (body.code !== "00") raiseForCode(body.code);

  return { stopId: String(stopId), arrivals: parseArrivals(body), fetchedAt: Date.now() };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npm test`
Expected: PASS — 15 tests total in `emt.test.js`.

- [ ] **Step 6: Commit**

```bash
git add api/src/emt.js api/test/
git commit -m "feat: fetch and parse EMT arrivals with one token retry"
```

---

### Task 4: Supabase stop storage

**Files:**
- Create: `api/src/stops.js`, `api/test/stops.test.js`

**Interfaces:**
- Consumes: env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`; `EmtError` from Task 2.
- Produces:
  - `async function listStops(env) -> Array<{id, stop_id, label, enabled}>`
  - `async function addStop(env, {stopId, label}) -> {id, stop_id, label, enabled}`
  - `async function removeStop(env, id) -> void`

- [ ] **Step 1: Write the failing tests**

Create `api/test/stops.test.js`:

```js
import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { listStops, addStop, removeStop } from "../src/stops.js";

function mockFetch(body, init = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    })
  );
}

afterEach(() => vi.restoreAllMocks());

describe("listStops", () => {
  it("returns the rows Supabase sends", async () => {
    mockFetch([{ id: "u1", stop_id: "1234", label: "home", enabled: true }]);
    const stops = await listStops(env);
    expect(stops).toEqual([
      { id: "u1", stop_id: "1234", label: "home", enabled: true },
    ]);
  });

  it("sends the service key in both required headers", async () => {
    const spy = mockFetch([]);
    await listStops(env);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("/rest/v1/bus_stops");
    expect(init.headers.apikey).toBe(env.SUPABASE_SERVICE_KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${env.SUPABASE_SERVICE_KEY}`);
  });

  it("raises upstream when Supabase errors", async () => {
    mockFetch({ message: "boom" }, { status: 500 });
    await expect(listStops(env)).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("addStop", () => {
  it("returns the created row", async () => {
    mockFetch([{ id: "u2", stop_id: "5678", label: null, enabled: true }]);
    const row = await addStop(env, { stopId: "5678", label: null });
    expect(row.stop_id).toBe("5678");
  });

  it("asks Supabase to return the inserted representation", async () => {
    const spy = mockFetch([{ id: "u2", stop_id: "5678" }]);
    await addStop(env, { stopId: "5678", label: "work" });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers.Prefer).toContain("return=representation");
    expect(JSON.parse(init.body)).toEqual({ stop_id: "5678", label: "work" });
  });

  it("rejects a non-numeric stop id before calling Supabase", async () => {
    const spy = mockFetch([]);
    await expect(addStop(env, { stopId: "abc" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("removeStop", () => {
  it("deletes by row id", async () => {
    const spy = mockFetch([], { status: 204 });
    await removeStop(env, "u1");
    const [url, init] = spy.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("id=eq.u1");
  });
});
```

- [ ] **Step 2: Add Supabase test vars**

Add to `api/wrangler.toml` under `[vars]`:

```toml
SUPABASE_URL = "https://test.supabase.co"
SUPABASE_SERVICE_KEY = "test-service-key"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && npm test`
Expected: FAIL — `Cannot find module '../src/stops.js'`.

- [ ] **Step 4: Implement the Supabase client**

Create `api/src/stops.js`. Plain REST, no SDK — matching the `innocent_project` pattern.

```js
import { EmtError } from "./errors.js";

const TABLE = "bus_stops";

function headers(env, extra = {}) {
  // Supabase wants the key twice: apikey identifies the project, Authorization
  // carries the role. The service role bypasses RLS, which is the only way to
  // reach a table with zero policies.
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function call(env, path, init = {}) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: headers(env, init.headers),
    });
  } catch (cause) {
    throw new EmtError("upstream", `Supabase unreachable: ${cause.message}`);
  }
  if (!res.ok) {
    throw new EmtError("upstream", `Supabase HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listStops(env) {
  return call(env, `${TABLE}?select=*&order=created_at.asc`);
}

export async function addStop(env, { stopId, label = null }) {
  // The table has the same check constraint; failing here gives the page a
  // clearer error than a Postgres constraint violation would.
  if (!/^[0-9]+$/.test(String(stopId ?? ""))) {
    throw new EmtError("not_found", `not a valid stop id: ${stopId}`);
  }
  const rows = await call(env, TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ stop_id: String(stopId), label }),
  });
  return rows[0];
}

export async function removeStop(env, id) {
  await call(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npm test`
Expected: PASS — 8 tests in `stops.test.js`.

- [ ] **Step 6: Commit**

```bash
git add api/src/stops.js api/test/stops.test.js api/wrangler.toml
git commit -m "feat: Supabase stop storage over plain REST"
```

---

### Task 5: Worker routing, CORS, write key, and the 20s arrivals cache

**Files:**
- Create: `api/src/index.js`, `api/test/index.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–4, plus env `APP_KEY`, `ALLOWED_ORIGIN`.
- Produces: the worker's `fetch` handler serving `GET /stops`, `POST /stops`, `DELETE /stops/:id`, `GET /arrivals?stop=<id>`.

- [ ] **Step 1: Write the failing tests**

Create `api/test/index.test.js`:

```js
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";
import arrivalsOk from "./fixtures/arrivals-ok.json";

async function call(path, init) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://w.dev${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  await env.KV.put("emt:token", "cached-token");
  await env.KV.delete("arrivals:1234");
});
afterEach(() => vi.restoreAllMocks());

describe("CORS", () => {
  it("answers preflight with the allowed origin", async () => {
    const res = await call("/stops", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-App-Key");
  });
});

describe("write protection", () => {
  it("rejects a POST without the app key", async () => {
    const res = await call("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId: "1234" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a DELETE without the app key", async () => {
    const res = await call("/stops/u1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("allows a GET without the app key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("/stops");
    expect(res.status).toBe(200);
  });
});

describe("GET /arrivals", () => {
  it("returns parsed arrivals", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(arrivalsOk), { status: 200 })
    );
    const res = await call("/arrivals?stop=1234");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.arrivals).toHaveLength(2);
  });

  it("serves the second call from cache, making no upstream request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(arrivalsOk), { status: 200 })
    );
    await call("/arrivals?stop=1234");
    const res = await call("/arrivals?stop=1234");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await res.json()).arrivals).toHaveLength(2);
  });

  it("requires a stop parameter", async () => {
    const res = await call("/arrivals");
    expect(res.status).toBe(400);
  });

  it("reports quota exhaustion as 503", async () => {
    await env.KV.delete("emt:token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "98", data: [] }), { status: 200 })
    );
    const res = await call("/arrivals?stop=1234");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("quota");
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && npm test`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Implement the router**

Create `api/src/index.js`:

```js
import { getArrivals } from "./emt.js";
import { listStops, addStop, removeStop } from "./stops.js";
import { EmtError, errorResponse } from "./errors.js";

const ARRIVALS_TTL = 20; // seconds; also blunts quota abuse of the open endpoint

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,X-App-Key",
  };
}

function json(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });
}

/** The key ships in public JS. It filters scanners, not people — see the spec. */
function hasAppKey(request, env) {
  return request.headers.get("X-App-Key") === env.APP_KEY;
}

async function cachedArrivals(env, stopId) {
  const key = `arrivals:${stopId}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getArrivals(env, stopId);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: ARRIVALS_TTL });
  return fresh;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    const isWrite = method === "POST" || method === "DELETE";
    if (isWrite && !hasAppKey(request, env)) {
      return json({ error: "unauthorized" }, env, 401);
    }

    try {
      if (pathname === "/arrivals" && method === "GET") {
        const stop = url.searchParams.get("stop");
        if (!stop) return json({ error: "missing stop parameter" }, env, 400);
        return json(await cachedArrivals(env, stop), env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env), env);
      }

      if (pathname === "/stops" && method === "POST") {
        const { stopId, label = null } = await request.json();
        return json(await addStop(env, { stopId, label }), env, 201);
      }

      const del = pathname.match(/^\/stops\/([^/]+)$/);
      if (del && method === "DELETE") {
        await removeStop(env, del[1]);
        return new Response(null, { status: 204, headers: cors(env) });
      }

      return json({ error: "not found" }, env, 404);
    } catch (err) {
      if (err instanceof EmtError) return errorResponse(err, cors(env));
      return errorResponse(new EmtError("upstream", err.message), cors(env));
    }
  },
};
```

- [ ] **Step 4: Add the allowed origin to test vars**

Add to `api/wrangler.toml` under `[vars]` if not already present:

```toml
ALLOWED_ORIGIN = "https://snowu.github.io"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd api && npm test`
Expected: PASS — all tests across all three files.

- [ ] **Step 6: Commit**

```bash
git add api/src/index.js api/test/index.test.js api/wrangler.toml
git commit -m "feat: worker routing with CORS, write key, and 20s arrivals cache"
```

---

### Task 6: The page — render stops with countdown and staleness

**Files:**
- Create: `web/index.html`, `web/cache.js`, `web/app.js`, `web/style.css`

**Interfaces:**
- Consumes: the worker endpoints from Task 5.
- Produces: a working page. `cache.js` exports `readCache()`, `writeCache(stopId, payload)`, `readStops()`, `writeStops(stops)`.

- [ ] **Step 1: Write the cache module**

Create `web/cache.js`. localStorage is a per-device cache of last-known arrivals — never the source of truth for saved stops.

```js
const ARRIVALS_KEY = "emt:arrivals";
const STOPS_KEY = "emt:stops";

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readCache() {
  return read(ARRIVALS_KEY, {});
}

export function writeCache(stopId, payload) {
  const all = readCache();
  all[stopId] = payload;
  localStorage.setItem(ARRIVALS_KEY, JSON.stringify(all));
}

/** Mirrors the stop list so a cold start with no network still renders. */
export function readStops() {
  return read(STOPS_KEY, []);
}

export function writeStops(stops) {
  localStorage.setItem(STOPS_KEY, JSON.stringify(stops));
}
```

- [ ] **Step 2: Write the page shell**

Create `web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#12141a" />
    <title>Buses</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header>
      <h1>Buses</h1>
      <button id="refresh-all" type="button">Refresh all</button>
    </header>

    <main id="stops" aria-live="polite"></main>

    <form id="add-stop">
      <input
        id="stop-id"
        inputmode="numeric"
        pattern="[0-9]*"
        placeholder="Stop number"
        required
        aria-label="EMT stop number"
      />
      <input id="stop-label" placeholder="Label (optional)" aria-label="Label" />
      <button type="submit">Add</button>
    </form>

    <p id="status" role="status"></p>
    <footer>Data from <a href="https://mobilitylabs.emtmadrid.es">EMT MobilityLabs</a>.</footer>

    <script type="module" src="app.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the app logic**

Create `web/app.js`. Set `API` to the deployed worker URL in Task 7.

```js
import { readCache, writeCache, readStops, writeStops } from "./cache.js";

const API = "https://emt-arrivals.<your-subdomain>.workers.dev";
const APP_KEY = "replace-me"; // public by design; filters scanners, not people

const stopsEl = document.getElementById("stops");
const statusEl = document.getElementById("status");

let stops = readStops();
let arrivals = readCache();

function fmtCountdown(seconds) {
  if (seconds <= 0) return "due";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function fmtAge(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function render() {
  stopsEl.replaceChildren(
    ...stops.map((stop) => {
      const cached = arrivals[stop.stop_id];
      const card = document.createElement("article");
      card.className = "stop";

      const title = document.createElement("h2");
      title.textContent = stop.label || `Stop ${stop.stop_id}`;

      const refresh = document.createElement("button");
      refresh.textContent = "↻";
      refresh.title = "Refresh this stop";
      refresh.addEventListener("click", () => refreshStop(stop.stop_id));

      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove this stop";
      remove.addEventListener("click", () => deleteStop(stop.id));

      const list = document.createElement("ul");
      if (!cached) {
        list.innerHTML = `<li class="muted">No data yet</li>`;
      } else if (cached.arrivals.length === 0) {
        list.innerHTML = `<li class="muted">Nothing due</li>`;
      } else {
        // Count down from the age of the fetch, not from the raw value, so a
        // cached payload shows the time remaining now rather than when fetched.
        const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
        for (const bus of cached.arrivals) {
          const li = document.createElement("li");
          const line = document.createElement("span");
          line.className = "line";
          line.textContent = bus.line;
          const eta = document.createElement("span");
          eta.className = "eta";
          eta.textContent = fmtCountdown(bus.seconds - elapsed);
          li.append(line, eta);
          list.append(li);
        }
      }

      // Every rendering of arrival data carries its age. A stale number is fine;
      // a stale number without its age is not.
      const age = document.createElement("p");
      age.className = "age";
      age.textContent = cached ? `updated ${fmtAge(cached.fetchedAt)}` : "never updated";

      const controls = document.createElement("div");
      controls.className = "controls";
      controls.append(refresh, remove);

      const head = document.createElement("div");
      head.className = "head";
      head.append(title, controls);

      card.append(head, list, age);
      return card;
    })
  );
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "X-App-Key": APP_KEY, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.kind = body.error; // "quota" | "auth" | "not_found" | "upstream"
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function refreshStop(stopId) {
  try {
    const payload = await api(`/arrivals?stop=${encodeURIComponent(stopId)}`);
    arrivals[stopId] = payload;
    writeCache(stopId, payload);
    statusEl.textContent = "";
    render();
  } catch (err) {
    // Keep whatever is on screen; it is labelled with its age already.
    statusEl.textContent =
      err.kind === "quota"
        ? "EMT daily quota spent — showing cached times until it resets."
        : `Could not refresh stop ${stopId}: ${err.message}`;
  }
}

async function refreshAll() {
  await Promise.all(stops.map((s) => refreshStop(s.stop_id)));
}

async function loadStops() {
  try {
    stops = await api("/stops");
    writeStops(stops);
  } catch (err) {
    statusEl.textContent = `Showing saved stops: ${err.message}`;
  }
  render();
  await refreshAll();
}

async function deleteStop(id) {
  try {
    await api(`/stops/${id}`, { method: "DELETE" });
    stops = stops.filter((s) => s.id !== id);
    writeStops(stops);
    render();
  } catch (err) {
    statusEl.textContent = `Could not remove stop: ${err.message}`;
  }
}

document.getElementById("add-stop").addEventListener("submit", async (event) => {
  event.preventDefault();
  const idInput = document.getElementById("stop-id");
  const labelInput = document.getElementById("stop-label");
  try {
    const row = await api("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId: idInput.value.trim(), label: labelInput.value.trim() || null }),
    });
    stops.push(row);
    writeStops(stops);
    idInput.value = "";
    labelInput.value = "";
    render();
    await refreshStop(row.stop_id);
  } catch (err) {
    statusEl.textContent = `Could not add stop: ${err.message}`;
  }
});

document.getElementById("refresh-all").addEventListener("click", refreshAll);

// Re-render every second so countdowns and ages tick without refetching.
setInterval(render, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAll();
});

render(); // paint cached data immediately; never show an empty screen
loadStops();
```

- [ ] **Step 4: Write the stylesheet**

Create `web/style.css`:

```css
:root {
  --bg: #12141a;
  --card: #1b1f28;
  --fg: #f2f4f8;
  --muted: #8b93a7;
  --accent: #4ea3ff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 1rem;
  padding-bottom: env(safe-area-inset-bottom, 1rem);
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.4 system-ui, -apple-system, sans-serif;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

h1 { font-size: 1.25rem; margin: 0; }

button {
  background: var(--card);
  color: var(--fg);
  border: 1px solid #2c313d;
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
  cursor: pointer;
}

.stop {
  background: var(--card);
  border-radius: 12px;
  padding: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}

.head { display: flex; align-items: center; justify-content: space-between; }
.head h2 { font-size: 1rem; margin: 0; }
.controls { display: flex; gap: 0.35rem; }

.stop ul { list-style: none; margin: 0.5rem 0 0; padding: 0; }

.stop li {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid #252a35;
}

.stop li:last-child { border-bottom: none; }

.line {
  font-weight: 700;
  color: var(--accent);
  min-width: 3ch;
}

.eta { font-variant-numeric: tabular-nums; font-size: 1.25rem; }

.muted { color: var(--muted); }

.age {
  margin: 0.5rem 0 0;
  font-size: 0.8rem;
  color: var(--muted);
}

form {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

input {
  flex: 1;
  min-width: 0;
  background: var(--card);
  border: 1px solid #2c313d;
  border-radius: 8px;
  color: var(--fg);
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
}

#status { color: #ffb454; font-size: 0.85rem; min-height: 1.2em; }

footer { color: var(--muted); font-size: 0.75rem; margin-top: 2rem; }
footer a { color: var(--muted); }
```

- [ ] **Step 5: Verify the page loads against a local worker**

```bash
cd api && npx wrangler dev &
cd web && npx serve . -l 8788
```

Temporarily set `API = "http://localhost:8787"` in `app.js`, open `http://localhost:8788`, and confirm: the page renders, adding a stop works, arrivals appear, the countdown ticks each second, and the age line updates. Revert `API` before committing.

Expected without EMT credentials in `.dev.vars`: stops still add and list (Supabase path works), and arrivals show the error in `#status` while the layout stays intact. That is the never-render-empty behaviour working.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat: arrivals page with local countdown and staleness marker"
```

---

### Task 7: Deploy

**Files:**
- Modify: `web/app.js` (real worker URL and app key)
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: a live page and a live worker.

- [ ] **Step 1: Create the Supabase table**

Paste `supabase/bus_stops.sql` into the Supabase SQL editor and run it. Confirm in the dashboard that RLS is enabled and the policy list is empty.

- [ ] **Step 2: Set the worker secrets**

```bash
cd api
npx wrangler secret put EMT_EMAIL
npx wrangler secret put EMT_PASSWORD
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put APP_KEY
```

`APP_KEY` can be any random string: `openssl rand -hex 16`.

- [ ] **Step 3: Deploy the worker**

```bash
cd api && npx wrangler deploy
```

Note the deployed URL. Verify it is alive:

```bash
curl -s "https://<worker-url>/stops" | head
```

Expected: `[]`, or the rows already added.

- [ ] **Step 4: Point the page at the worker**

In `web/app.js`, set `API` to the deployed worker URL and `APP_KEY` to the value from Step 2. Set `ALLOWED_ORIGIN` in `wrangler.toml` to the GitHub Pages origin (`https://<user>.github.io`), then redeploy the worker so CORS matches.

- [ ] **Step 5: Add the Pages workflow**

Create `.github/workflows/pages.yml`:

```yaml
name: Deploy page
on:
  push:
    branches: [main]
    paths: ["web/**", ".github/workflows/pages.yml"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: web
      - id: deployment
        uses: actions/deploy-pages@v4
```

In the repo settings, set Pages → Source to "GitHub Actions".

- [ ] **Step 6: Commit and verify end to end**

```bash
git add web/app.js api/wrangler.toml .github/workflows/pages.yml
git commit -m "chore: deploy page to GitHub Pages and point it at the worker"
git push
```

Then on your phone: open the Pages URL, add a real stop, confirm arrivals appear and count down. Open the same URL on the laptop and confirm the stop is already there — that is the cross-device requirement met. Finally, "Add to Home Screen".

---

## Manual verification checklist

Run after Task 7, on the phone:

- [ ] Adding a stop on the phone makes it appear on the laptop after a reload.
- [ ] Countdowns tick down every second without a network request.
- [ ] The age line ("updated Ns ago") climbs between refreshes.
- [ ] Airplane mode: arrivals still render from cache, with their age shown, and `#status` explains the failure.
- [ ] A nonsense stop number (e.g. `99999999`) reports a clear error rather than hanging.
- [ ] Backgrounding the tab and returning triggers a refresh.
- [ ] `curl -X POST <worker>/stops -d '{"stopId":"1"}'` without `X-App-Key` returns 401.
