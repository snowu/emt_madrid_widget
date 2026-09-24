import { authenticatedUser, bearerToken } from "./auth.js";
import { EmtError } from "./errors.js";
import { getToken } from "./emt.js";

/* Per-user EMT connections.
 *
 * Users connect their own EMT email and password, and EMT calls made on their
 * behalf use their own MobilityLabs quota. The shared login (EMT_EMAIL) is the
 * owner's: with EMT_SHARED_LOGIN = "owner" only OWNER_USER_ID may use it, and
 * everyone else must connect before anything needs a fresh EMT call — one
 * quota cannot carry every user of everything planned on top of it. Cached
 * public payloads are still served to anyone. "everyone" (the default when
 * unset, and what the older tests run with) lets anyone without a connection
 * use the shared login.
 *
 * The credentials are AES-256-GCM encrypted with the EMT_CREDENTIAL_KEY Worker
 * secret, bound to the app user id as associated data, and stored in the
 * RLS-protected `emt_accounts` table (supabase/emt-accounts.sql). Only the
 * ciphertext leaves the Worker; passwords never reach browser storage and no
 * response ever carries one. The user's tracking runner holds a copy of the
 * same ciphertext so timer-driven checks can use their quota too.
 */

const encode = (value) => new TextEncoder().encode(value);
const base64 = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));
const bytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

async function vaultKey(env) {
  try {
    const raw = bytes(env.EMT_CREDENTIAL_KEY);
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new EmtError("upstream", "EMT account storage is not configured"); }
}

export async function sealCredentials(env, userId, credentials) {
  const key = await vaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: encode(`emt-account:v1:${userId}`),
  }, key, encode(JSON.stringify(credentials)));
  return { version: 1, iv: base64(iv), ciphertext: base64(ciphertext) };
}

export async function openCredentials(env, userId, sealed) {
  const key = await vaultKey(env);
  try {
    if (sealed?.version !== 1) throw new Error();
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: bytes(sealed.iv), additionalData: encode(`emt-account:v1:${userId}`),
    }, key, bytes(sealed.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch { throw new EmtError("emt_account", "Reconnect your EMT account"); }
}

/** The caller's row, read and written through PostgREST with their own JWT:
 *  RLS is what keeps one user out of another's row. */
export async function accountRow(env, request, user, init = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/emt_accounts?user_id=eq.${encodeURIComponent(user.id)}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${bearerToken(request)}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    signal: AbortSignal.timeout(8000),
  });
  // Never expose database diagnostics or credential records.
  if (!response.ok) throw new EmtError("upstream", "EMT account storage unavailable");
  return init.method ? null : (await response.json())[0] ?? null;
}

/** An env whose EMT login is this user's. `sessionId` names their token in
 *  KV and in isolate memory, so no two users ever share a token. */
export function scopedEnvironment(env, credentials, sessionId) {
  return {
    ...env, EMT_ACCOUNT_CONTEXT: undefined,
    EMT_EMAIL: credentials.email, EMT_PASSWORD: credentials.password,
    EMT_SESSION_ID: sessionId,
  };
}

/** Whether this deployment keeps the shared login for its owner alone. */
export const sharedLoginIsOwners = (env) => env.EMT_SHARED_LOGIN === "owner" && Boolean(env.EMT_CREDENTIAL_KEY);

/** The env for one request, resolving the caller's connection lazily: public
 *  cache hits and GBFS reads never pay for the lookup. Resolves to the
 *  caller's own login when they connected one, and to null — the shared
 *  login — when the shared login is theirs to use. Otherwise the request
 *  fails with `emt_account`, which the page turns into "connect your
 *  account". A connection that exists but cannot be used also fails. */
export function withEmtAccount(env, request) {
  let pending;
  return {
    ...env,
    EMT_ACCOUNT_CONTEXT: () => pending ??= (async () => {
      if (!env.EMT_CREDENTIAL_KEY) return null; // feature not configured
      const ownerOnly = sharedLoginIsOwners(env);
      if (!request.headers.has("Authorization")) {
        if (ownerOnly) throw new EmtError("emt_account", "Sign in and connect your EMT account to load live times.");
        return null;
      }
      let user;
      let row;
      try {
        user = await authenticatedUser(env, request);
      } catch (error) {
        if (ownerOnly) throw error; // an expired session: sign in again
        return null;
      }
      const owner = Boolean(env.OWNER_USER_ID) && user.id === env.OWNER_USER_ID;
      try {
        row = await accountRow(env, request, user);
      } catch (error) {
        if (ownerOnly && !owner) throw error;
        return null;
      }
      if (!row) {
        if (ownerOnly && !owner) {
          throw new EmtError("emt_account", "Connect your EMT account from the account menu to load live times.");
        }
        return null;
      }
      const credentials = await openCredentials(env, user.id, row.credentials);
      return scopedEnvironment(env, credentials, `${user.id}:${row.connection_id}`);
    })(),
  };
}

async function credentialsBody(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new EmtError("bad_request", "Expected JSON credentials");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new EmtError("bad_request", "Missing credentials");
  const buffer = new Uint8Array(4096);
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.length > buffer.length) {
      await reader.cancel();
      throw new EmtError("bad_request", "Credentials too long");
    }
    buffer.set(value, size);
    size += value.length;
  }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))); }
  catch { throw new EmtError("bad_request", "Invalid JSON credentials"); }
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      typeof password !== "string" || !password || password.length > 1024 || /[\r\n]/.test(password)) {
    throw new EmtError("bad_request", "Enter a valid EMT email and password");
  }
  return { email, password };
}

/** GET / PUT / DELETE /auth/emt. Returns the connection state; `onChange`
 *  receives the stored row (or null) so the caller can hand it to the user's
 *  tracking runner. */
export async function manageEmtAccount(env, request, { onChange = async () => {} } = {}) {
  const user = await authenticatedUser(env, request);
  // Whether live data waits on this user connecting (everyone but the owner).
  const required = sharedLoginIsOwners(env) && user.id !== env.OWNER_USER_ID;
  if (request.method === "GET") {
    const row = await accountRow(env, request, user);
    await onChange(user, row);
    return { connected: Boolean(row), connectionId: row?.connection_id ?? null, required,
      email: row ? (await openCredentials(env, user.id, row.credentials)).email : null };
  }
  if (request.method === "DELETE") {
    await accountRow(env, request, user, { method: "DELETE" });
    await onChange(user, null);
    return { connected: false, connectionId: null, required, email: null };
  }
  const input = await credentialsBody(request);
  const credentials = await sealCredentials(env, user.id, input);
  const connectionId = crypto.randomUUID();
  // Log in with the new credentials before replacing a working connection.
  await getToken(scopedEnvironment(env, input, `${user.id}:${connectionId}`));
  const row = { user_id: user.id, connection_id: connectionId, credentials };
  await accountRow(env, request, user, { method: "POST", body: JSON.stringify(row) });
  await onChange(user, row);
  return { connected: true, connectionId, required, email: input.email };
}
