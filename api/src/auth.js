import { EmtError } from "./errors.js";

export function bearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new EmtError("user_auth", "sign in required");
  return match[1];
}

/** Ask Supabase Auth to validate the JWT. Used only where we need identity
 * metadata (currently the owner-only BiciMAD account route). Ordinary saved
 * data calls pass the JWT straight to PostgREST, where RLS validates it. */
export async function authenticatedUser(env, request) {
  const token = bearerToken(request);
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new EmtError("user_auth", "session expired");
  const user = await response.json();
  if (!user?.id) throw new EmtError("user_auth", "invalid user session");
  return user;
}
