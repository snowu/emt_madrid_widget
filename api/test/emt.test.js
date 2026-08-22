import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getToken } from "../src/emt.js";
import { EmtError } from "../src/errors.js";
import loginOk from "./fixtures/login-ok.json";
import loginBadPassword from "./fixtures/login-bad-password.json";

function mockFetch(body, init = {}) {
  // A fresh Response per call: response bodies are single-use.
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200, ...init })
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
    mockFetch(loginOk);
    const token = await getToken(env);
    expect(token).toBe("fake-token-abc123");
  });

  it("sends credentials as headers, not as a body", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v1/mobilitylabs/user/login/");
    expect(init.method).toBe("GET");
    expect(init.headers.email).toBe(env.EMT_EMAIL);
    expect(init.headers.password).toBe(env.EMT_PASSWORD);
    expect(init.body).toBeUndefined();
  });

  it("caches the token in KV so a second call makes no request", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    await getToken(env);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-logs in when force is set, even with a cached token", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    await getToken(env, { force: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws an auth error on code 89, a 200 response", async () => {
    mockFetch(loginBadPassword);
    await expect(getToken(env)).rejects.toMatchObject({
      name: "EmtError",
      kind: "auth",
    });
  });

  it("throws a quota error on code 98", async () => {
    mockFetch({ code: "98", description: "limit", data: [] });
    await expect(getToken(env)).rejects.toMatchObject({ kind: "quota" });
  });

  it("throws an upstream error on a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("gateway timeout", { status: 504 })
    );
    await expect(getToken(env)).rejects.toMatchObject({ kind: "upstream" });
  });
});
