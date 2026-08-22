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
