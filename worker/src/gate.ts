// The OnePortal gate in front of every car route. Pure apart from WebCrypto,
// so it runs in the plain-node unit tests. index.ts calls it before anything
// reaches a car; oneportal.ts holds the pass and cookie formats.

import {
  DEFAULT_ONEPORTAL_ORIGIN, PASS_PARAM, cookieName, makeCookie, readCookie, refreshUrl,
  setCookieHeader, verifyCookie, verifyPass, withoutPass, type DashboardRole,
} from "./oneportal";
import type { Route } from "./routes";

export interface GateEnv {
  ONEPORTAL_PASS_PUBLIC_KEY?: string;
  ONEPORTAL_COOKIE_SECRET?: string;
  REQUIRE_ONEPORTAL?: string;
  ONEPORTAL_ORIGIN?: string;
}

/** What the request may do, or the answer to send instead. */
export type GateResult =
  | { pass: true; role: DashboardRole; via: "oneportal" | "access-only" }
  | { pass: false; response: Response };

type CarRoute = Exclude<Route, { kind: "landing" } | { kind: "api-cars" } | { kind: "not-found" }>;

const NO_STORE = { "Cache-Control": "no-store" };

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE, ...headers } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(status: number, title: string, body: string, origin: string): Response {
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${escapeHtml(title)}</title>`
    + `<body style="font-family:system-ui;margin:3rem;max-width:40rem"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1>`
    + `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(origin)}/">Open OnePortal</a></p>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE, "Referrer-Policy": "no-referrer", ...extra } });
}

export function oneportalRequired(env: GateEnv): boolean {
  return env.REQUIRE_ONEPORTAL === "1";
}

export function oneportalOrigin(env: GateEnv): string {
  return env.ONEPORTAL_ORIGIN || DEFAULT_ONEPORTAL_ORIGIN;
}

/** A page load the browser can be redirected on (not a script, image or socket). */
function isPageLoad(request: Request, route: CarRoute): boolean {
  if (route.kind === "car-root" || route.kind === "app-slash") return true;
  if (route.kind !== "app") return false;
  const mode = request.headers.get("Sec-Fetch-Mode");
  if (mode) return mode === "navigate";
  return route.assetPath.endsWith(".html");
}

/**
 * Checks a car request against OnePortal.
 *
 *  - `?oneportal_pass=` is verified and swapped for the op_<car> cookie, then
 *    the browser is sent to the same URL without the pass.
 *  - A valid cookie gives its role.
 *  - Neither: with REQUIRE_ONEPORTAL=1, page loads go to OnePortal's refresh
 *    and everything else is refused; without it, Access alone still counts as
 *    full access (the pre-OnePortal behaviour, for the staged rollout).
 */
export async function gate(request: Request, env: GateEnv, route: CarRoute, user: string | null, now: number): Promise<GateResult> {
  const required = oneportalRequired(env);
  const origin = oneportalOrigin(env);
  const publicKey = env.ONEPORTAL_PASS_PUBLIC_KEY;
  const secret = env.ONEPORTAL_COOKIE_SECRET;
  const configured = Boolean(publicKey && secret);
  if (!configured) {
    // Fail closed: requiring OnePortal without the means to check it locks everyone out.
    if (required) return { pass: false, response: text(500, "site misconfigured: ONEPORTAL_PASS_PUBLIC_KEY and ONEPORTAL_COOKIE_SECRET must both be set when REQUIRE_ONEPORTAL=1") };
    return { pass: true, role: "control", via: "access-only" };
  }

  const url = new URL(request.url);
  const car = route.car;
  const pass = url.searchParams.get(PASS_PARAM);

  if (pass !== null) {
    if (!user) return { pass: false, response: page(403, "Not signed in", "This request has no Cloudflare Access identity.", origin) };
    const result = await verifyPass(pass, { publicKey: publicKey!, car, user, now });
    if (!result.ok) {
      if (result.reason === "expired") return { pass: false, response: redirect(refreshUrl(origin, car, url.pathname)) };
      return { pass: false, response: page(403, "This dashboard link is not valid", `The OnePortal pass was refused (${result.reason}). Open the dashboard again from OnePortal.`, origin) };
    }
    const cookie = await makeCookie(result.grant, secret!, now);
    return { pass: false, response: redirect(withoutPass(url), { "Set-Cookie": setCookieHeader(car, cookie.value) }) };
  }

  const value = readCookie(request.headers, cookieName(car));
  const grant = value && user ? await verifyCookie(value, { secret: secret!, car, user, now }) : null;
  if (grant) return { pass: true, role: grant.role, via: "oneportal" };

  if (!required) return { pass: true, role: "control", via: "access-only" };
  if (isPageLoad(request, route)) return { pass: false, response: redirect(refreshUrl(origin, car, url.pathname)) };
  return { pass: false, response: text(401, `open this dashboard from OnePortal: ${origin}/`) };
}

/** Routes that can change the car: the control link, and the bridge (parameters and services). */
export function needsControl(route: Route): boolean {
  return route.kind === "control" || route.kind === "bridge";
}

export const VIEW_ONLY_MESSAGE = "You can view this car but not change it. Ask a OnePortal administrator for dashboard control.";
