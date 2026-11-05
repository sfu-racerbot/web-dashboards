// OnePortal is the only way into a car's dashboard.
//
// OnePortal (https://oneportal.sighton.ca) decides who may see or drive which
// car. When someone opens a dashboard there, OnePortal signs a short *pass*
// with its Ed25519 key and sends the browser here with `?oneportal_pass=...`.
// This Worker:
//
//   1. verifies the pass with OnePortal's PUBLIC key (ONEPORTAL_PASS_PUBLIC_KEY),
//      so it holds no OnePortal secret and never calls OnePortal;
//   2. checks the pass is for this car and for the person Access signed in;
//   3. swaps it for its own cookie, `op_<car>`, HMAC-signed with
//      ONEPORTAL_COOKIE_SECRET, valid 15 minutes, path /<car>/;
//   4. without a valid cookie, sends pages back to OnePortal's
//      /dashboard/refresh, which issues a new pass with the person's current
//      role or refuses. So a role change in OnePortal applies within 15 minutes.
//
// Pass:   <b64url(JSON {v:1, iss:"oneportal", email, car, role, exp, jti})>.<b64url(Ed25519 sig over the first part)>
// Cookie: <b64url(JSON {email, car, role, exp})>.<b64url(HMAC-SHA256 over the first part)>
// exp is in milliseconds in both.

export type DashboardRole = "view" | "control";

export interface Grant {
  email: string;
  car: string;
  role: DashboardRole;
  exp: number;
}

export const PASS_PARAM = "oneportal_pass";
export const COOKIE_TTL_MS = 15 * 60_000;
/** Passes are signed for 2 minutes; this much clock difference is tolerated on top. */
export const CLOCK_SKEW_MS = 30_000;
export const DEFAULT_ONEPORTAL_ORIGIN = "https://oneportal.sighton.ca";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(decoder.decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function asGrant(p: Record<string, unknown>): Grant | null {
  const { email, car, role, exp } = p;
  if (typeof email !== "string" || !email || typeof car !== "string" || !car) return null;
  if (role !== "view" && role !== "control") return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return { email: email.toLowerCase(), car, role, exp };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function publicKey(raw: string): Promise<CryptoKey> {
  let key = keyCache.get(raw);
  if (!key) {
    const bytes = b64urlDecode(raw);
    if (!bytes || bytes.length !== 32) return Promise.reject(new Error("ONEPORTAL_PASS_PUBLIC_KEY is not a 32-byte base64url Ed25519 key"));
    key = crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(raw, key);
  }
  return key;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export type PassResult = { ok: true; grant: Grant } | { ok: false; reason: string };

/**
 * A OnePortal pass, verified: signature, issuer, version, expiry, car, and
 * that it was issued to the person Access signed in.
 */
export async function verifyPass(
  pass: string,
  opts: { publicKey: string; car: string; user: string; now: number },
): Promise<PassResult> {
  const parts = pass.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sigText] = parts;
  const sig = b64urlDecode(sigText);
  const bodyBytes = b64urlDecode(body);
  if (!sig || sig.length !== 64 || !bodyBytes) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(opts.publicKey), sig, encoder.encode(body));
  if (!valid) return { ok: false, reason: "bad signature" };
  const payload = parseJson(bodyBytes);
  if (!payload || payload.v !== 1 || payload.iss !== "oneportal") return { ok: false, reason: "not a OnePortal pass" };
  const grant = asGrant(payload);
  if (!grant) return { ok: false, reason: "malformed" };
  if (grant.exp <= opts.now - CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  if (grant.exp > opts.now + 10 * 60_000) return { ok: false, reason: "expiry too far ahead" };
  if (grant.car !== opts.car) return { ok: false, reason: "for another car" };
  if (grant.email !== opts.user.toLowerCase()) return { ok: false, reason: "issued to someone else" };
  return { ok: true, grant };
}

export function cookieName(car: string): string {
  return `op_${car}`;
}

export async function makeCookie(grant: Omit<Grant, "exp">, secret: string, now: number): Promise<{ value: string; exp: number }> {
  const exp = now + COOKIE_TTL_MS;
  const body = b64urlEncode(encoder.encode(JSON.stringify({ email: grant.email, car: grant.car, role: grant.role, exp })));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return { value: `${body}.${b64urlEncode(mac)}`, exp };
}

export function setCookieHeader(car: string, value: string): string {
  return `${cookieName(car)}=${value}; Path=/${car}/; Max-Age=${COOKIE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The cookie's grant if its MAC, car, person and expiry all check out; otherwise null. */
export async function verifyCookie(
  value: string,
  opts: { secret: string; car: string; user: string; now: number },
): Promise<Grant | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, macText] = parts;
  const mac = b64urlDecode(macText);
  const bodyBytes = b64urlDecode(body);
  if (!mac || !bodyBytes) return null;
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(opts.secret), mac, encoder.encode(body)))) return null;
  const payload = parseJson(bodyBytes);
  const grant = payload && asGrant(payload);
  if (!grant) return null;
  if (grant.exp <= opts.now || grant.exp > opts.now + COOKIE_TTL_MS + CLOCK_SKEW_MS) return null;
  if (grant.car !== opts.car || grant.email !== opts.user.toLowerCase()) return null;
  return grant;
}

/** Where to send a browser that has no valid cookie for this car. */
export function refreshUrl(oneportalOrigin: string, car: string, pathname: string): string {
  const u = new URL("/dashboard/refresh", oneportalOrigin);
  u.searchParams.set("car", car);
  // OnePortal accepts only a plain path under /<car>/, so the query is dropped.
  if (pathname.startsWith(`/${car}/`) && !pathname.includes("..")) u.searchParams.set("return", pathname);
  return u.toString();
}

/** The same URL with the pass removed, so it does not stay in history or a Referer. */
export function withoutPass(url: URL): string {
  const clean = new URL(url.toString());
  clean.searchParams.delete(PASS_PARAM);
  return clean.toString();
}
