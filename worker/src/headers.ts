// The headers a request to a car origin carries. Pure, and unit-tested,
// because the whole security argument rests on it (docs/security.md):
//
//  - The car origins sit behind a Cloudflare Access "Service Auth" policy,
//    so the service token added here is the only way in.
//  - The car trusts X-Racerbot-User and X-Racerbot-Role because only this
//    Worker can reach it. That holds only if a browser can never supply
//    them itself, so any it sent are deleted BEFORE ours are set.

export type Role = "relay" | "control";

export interface OriginHeaderOptions {
  clientId: string;
  clientSecret: string;
  /** X-Racerbot-Role. Bridge and camera requests carry none. */
  role?: Role;
  /** X-Racerbot-User: the Access-authenticated email. The relay carries none. */
  user?: string;
}

/**
 * Browser headers that are never forwarded to a car.
 *
 * - x-racerbot-*: ours to set, never the browser's.
 * - cf-access-client-*: the service token is ours; a browser-supplied one
 *   must not ride along (or replace ours if header order ever changed).
 * - cookie, cf-access-jwt-assertion, cf-access-authenticated-user-email,
 *   authorization: the user's own Access session for dashboard.sfuracerbot.ca.
 *   The car has no use for it, and it is a credential.
 */
const STRIPPED_EXACT = new Set([
  "cookie",
  "authorization",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "host",
]);

export function isStripped(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("x-racerbot-") || STRIPPED_EXACT.has(lower);
}

/**
 * Headers for a request to a car origin, built from the browser's.
 *
 * Everything not stripped passes through unchanged -- in particular Origin
 * (the car allows https://dashboard.sfuracerbot.ca), Upgrade and every
 * Sec-WebSocket-* header, so foxglove_bridge can negotiate its subprotocol.
 */
export function originRequestHeaders(incoming: Headers, opts: OriginHeaderOptions): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    if (!isStripped(name)) out.append(name, value);
  });
  out.set("CF-Access-Client-Id", opts.clientId);
  out.set("CF-Access-Client-Secret", opts.clientSecret);
  if (opts.role) out.set("X-Racerbot-Role", opts.role);
  if (opts.user) out.set("X-Racerbot-User", opts.user);
  return out;
}

/** The logged-in user, as Cloudflare Access reports it, or null. */
export function accessUser(incoming: Headers): string | null {
  const email = incoming.get("Cf-Access-Authenticated-User-Email");
  return email && email.trim() ? email.trim() : null;
}
