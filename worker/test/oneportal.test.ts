import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gate, needsControl } from "../src/gate";
import { COOKIE_TTL_MS, RENEW_WINDOW_MS, makeCookie, refreshUrl, verifyCookie, verifyPass } from "../src/oneportal";
import { lichtblickDeepLink, parseRoute } from "../src/routes";

// A pass exactly as OnePortal's apps/control/src/dashboard-pass.mjs makes one.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ format: "jwk" }).x as string;
const other = generateKeyPairSync("ed25519");
const NOW = 1_800_000_000_000;
const SECRET = "test-cookie-secret-0123456789abcdef";
const ORIGIN = "https://oneportal.sighton.ca";

function signPass(payload: Record<string, unknown>, key = privateKey): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`;
}
function pass(over: Record<string, unknown> = {}, key = privateKey): string {
  return signPass({ v: 1, iss: "oneportal", email: "a@sfu.ca", car: "rb1", role: "view", exp: NOW + 120_000, jti: "x", ...over }, key);
}
const ENV = { ONEPORTAL_PASS_PUBLIC_KEY: PUBLIC, ONEPORTAL_COOKIE_SECRET: SECRET, REQUIRE_ONEPORTAL: "1" };
const verify = (p: string, o: Partial<{ car: string; user: string; now: number }> = {}) =>
  verifyPass(p, { publicKey: PUBLIC, car: "rb1", user: "a@sfu.ca", now: NOW, ...o });

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://dashboard.sfuracerbot.ca${path}`, { headers });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const route = (path: string) => parseRoute(new URL(`https://x${path}`).pathname) as any;

async function cookieFor(role: "view" | "control", over: Partial<{ email: string; car: string }> = {}, now = NOW) {
  const c = await makeCookie({ email: "a@sfu.ca", car: "rb1", role, ...over }, SECRET, now);
  return `op_${over.car ?? "rb1"}=${c.value}`;
}

describe("verifyPass", () => {
  it("accepts a OnePortal pass for this car and person", async () => {
    expect(await verify(pass())).toEqual({ ok: true, grant: { email: "a@sfu.ca", car: "rb1", role: "view", exp: NOW + 120_000 } });
    expect(await verify(pass({ role: "control" }), { user: "A@SFU.ca" })).toMatchObject({ ok: true, grant: { role: "control" } });
  });

  it("refuses a pass signed by any other key", async () => {
    expect(await verify(pass({}, other.privateKey))).toEqual({ ok: false, reason: "bad signature" });
  });

  it("refuses a pass whose payload was changed after signing", async () => {
    const [, sig] = pass().split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, iss: "oneportal", email: "a@sfu.ca", car: "rb1", role: "control", exp: NOW + 120_000, jti: "x" })).toString("base64url");
    expect(await verify(`${forged}.${sig}`)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("refuses another car, another person, an expired pass and a far-future one", async () => {
    expect(await verify(pass({ car: "rb2" }))).toEqual({ ok: false, reason: "for another car" });
    expect(await verify(pass(), { user: "b@sfu.ca" })).toEqual({ ok: false, reason: "issued to someone else" });
    expect(await verify(pass({ exp: NOW - 31_000 }))).toEqual({ ok: false, reason: "expired" });
    expect(await verify(pass({ exp: NOW + 11 * 60_000 }))).toEqual({ ok: false, reason: "expiry too far ahead" });
  });

  it("refuses anything that is not a version-1 OnePortal pass with a known role", async () => {
    expect(await verify(pass({ iss: "someone" }))).toEqual({ ok: false, reason: "not a OnePortal pass" });
    expect(await verify(pass({ v: 2 }))).toEqual({ ok: false, reason: "not a OnePortal pass" });
    expect(await verify(pass({ role: "admin" }))).toEqual({ ok: false, reason: "malformed" });
    expect(await verify("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(await verify("a.b.c")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("the op_<car> cookie", () => {
  const check = (value: string, o: Partial<{ car: string; user: string; now: number; secret: string }> = {}) =>
    verifyCookie(value, { secret: SECRET, car: "rb1", user: "a@sfu.ca", now: NOW, ...o });

  it("round-trips and lasts 15 minutes", async () => {
    const c = await makeCookie({ email: "a@sfu.ca", car: "rb1", role: "control" }, SECRET, NOW);
    expect(await check(c.value)).toMatchObject({ role: "control", exp: NOW + COOKIE_TTL_MS });
    expect(await check(c.value, { now: NOW + COOKIE_TTL_MS })).toBeNull();
  });

  it("is refused with another secret, car or person, or when edited", async () => {
    const c = await makeCookie({ email: "a@sfu.ca", car: "rb1", role: "view" }, SECRET, NOW);
    expect(await check(c.value, { secret: "other" })).toBeNull();
    expect(await check(c.value, { car: "rb2" })).toBeNull();
    expect(await check(c.value, { user: "b@sfu.ca" })).toBeNull();
    const [, mac] = c.value.split(".");
    const edited = Buffer.from(JSON.stringify({ email: "a@sfu.ca", car: "rb1", role: "control", exp: NOW + COOKIE_TTL_MS })).toString("base64url");
    expect(await check(`${edited}.${mac}`)).toBeNull();
  });
});

describe("refreshUrl", () => {
  it("sends only a plain path under the car back to OnePortal", () => {
    expect(refreshUrl(ORIGIN, "rb1", "/rb1/simple/")).toBe(`${ORIGIN}/dashboard/refresh?car=rb1&return=%2Frb1%2Fsimple%2F`);
    expect(refreshUrl(ORIGIN, "rb1", "/rb2/simple/")).toBe(`${ORIGIN}/dashboard/refresh?car=rb1`);
    expect(refreshUrl(ORIGIN, "rb1", "/rb1/../x")).toBe(`${ORIGIN}/dashboard/refresh?car=rb1`);
  });
});

describe("gate", () => {
  it("swaps a valid pass for a cookie and drops the pass from the URL", async () => {
    const r = await gate(req(`/rb1/simple/?oneportal_pass=${pass()}&x=1`), ENV, route("/rb1/simple/"), "a@sfu.ca", NOW);
    expect(r.pass).toBe(false);
    if (r.pass) return;
    expect(r.response.status).toBe(302);
    expect(r.response.headers.get("Location")).toBe("https://dashboard.sfuracerbot.ca/rb1/simple/?x=1");
    const set = r.response.headers.get("Set-Cookie")!;
    expect(set).toMatch(/^op_rb1=[\w-]+\.[\w-]+; Path=\/rb1\/; Max-Age=900; HttpOnly; Secure; SameSite=Lax$/);
    const value = set.split(";")[0];
    expect(await gate(req("/rb1/control", { Cookie: value }), ENV, route("/rb1/control"), "a@sfu.ca", NOW))
      .toEqual({ pass: true, role: "view", via: "oneportal" });
  });

  it("refuses a bad pass with a page, and sends an expired one back through OnePortal", async () => {
    const bad = await gate(req(`/rb1/simple/?oneportal_pass=${pass({}, other.privateKey)}`), ENV, route("/rb1/simple/"), "a@sfu.ca", NOW);
    expect(bad.pass === false && bad.response.status).toBe(403);
    const someoneElse = await gate(req(`/rb1/simple/?oneportal_pass=${pass()}`), ENV, route("/rb1/simple/"), "b@sfu.ca", NOW);
    expect(someoneElse.pass === false && someoneElse.response.status).toBe(403);
    const noIdentity = await gate(req(`/rb1/simple/?oneportal_pass=${pass()}`), ENV, route("/rb1/simple/"), null, NOW);
    expect(noIdentity.pass === false && noIdentity.response.status).toBe(403);
    const old = await gate(req(`/rb1/simple/?oneportal_pass=${pass({ exp: NOW - 60_000 })}`), ENV, route("/rb1/simple/"), "a@sfu.ca", NOW);
    expect(old.pass === false && old.response.headers.get("Location")).toBe(refreshUrl(ORIGIN, "rb1", "/rb1/simple/"));
  });

  it("with OnePortal required, sends page loads to OnePortal and refuses everything else", async () => {
    const pageLoad = await gate(req("/rb1/simple/", { "Sec-Fetch-Mode": "navigate" }), ENV, route("/rb1/simple/"), "a@sfu.ca", NOW);
    expect(pageLoad.pass === false && pageLoad.response.headers.get("Location")).toBe(refreshUrl(ORIGIN, "rb1", "/rb1/simple/"));
    for (const path of ["/rb1/ws", "/rb1/control", "/rb1/bridge", "/rb1/camera/stream", "/rb1/check", "/rb1/access", "/rb1/simple/dashboard.js"]) {
      const r = await gate(req(path), ENV, route(path), "a@sfu.ca", NOW);
      expect(r.pass === false && r.response.status, path).toBe(401);
    }
  });

  it("refuses an expired cookie, another car's cookie and another person's", async () => {
    const expired = await cookieFor("control", {}, NOW - COOKIE_TTL_MS - 1);
    const otherCar = (await cookieFor("control", { car: "rb2" })).replace("op_rb2", "op_rb1");
    for (const Cookie of [expired, otherCar]) {
      const r = await gate(req("/rb1/control", { Cookie }), ENV, route("/rb1/control"), "a@sfu.ca", NOW);
      expect(r.pass).toBe(false);
    }
    const r = await gate(req("/rb1/control", { Cookie: await cookieFor("control") }), ENV, route("/rb1/control"), "b@sfu.ca", NOW);
    expect(r.pass).toBe(false);
    const none = await gate(req("/rb1/control", { Cookie: await cookieFor("control") }), ENV, route("/rb1/control"), null, NOW);
    expect(none.pass).toBe(false);
  });

  it("before the cutover, Access alone still works, but a cookie's role still counts", async () => {
    const staged = { ...ENV, REQUIRE_ONEPORTAL: undefined };
    expect(await gate(req("/rb1/control"), staged, route("/rb1/control"), "a@sfu.ca", NOW)).toEqual({ pass: true, role: "control", via: "access-only" });
    expect(await gate(req("/rb1/control", { Cookie: await cookieFor("view") }), staged, route("/rb1/control"), "a@sfu.ca", NOW))
      .toEqual({ pass: true, role: "view", via: "oneportal" });
  });

  it("finds the real cookie behind a stray one of the same name", async () => {
    const Cookie = `op_rb1=junk.junk; ${await cookieFor("control")}`;
    expect(await gate(req("/rb1/control", { Cookie }), ENV, route("/rb1/control"), "a@sfu.ca", NOW)).toEqual({ pass: true, role: "control", via: "oneportal" });
  });

  it("treats any REQUIRE_ONEPORTAL value but unset, empty or 0 as required", async () => {
    for (const v of ["1", "true", "yes", " 1 "]) {
      const r = await gate(req("/rb1/control"), { ...ENV, REQUIRE_ONEPORTAL: v }, route("/rb1/control"), "a@sfu.ca", NOW);
      expect(r.pass, v).toBe(false);
    }
    for (const v of [undefined, "", "0"]) {
      const r = await gate(req("/rb1/control"), { ...ENV, REQUIRE_ONEPORTAL: v }, route("/rb1/control"), "a@sfu.ca", NOW);
      expect(r.pass, String(v)).toBe(true);
    }
  });

  it("fails closed when OnePortal is required but its key or secret is missing", async () => {
    for (const env of [{ REQUIRE_ONEPORTAL: "1" }, { ...ENV, ONEPORTAL_COOKIE_SECRET: "" }, { ...ENV, ONEPORTAL_PASS_PUBLIC_KEY: undefined }]) {
      const r = await gate(req("/rb1/simple/"), env, route("/rb1/simple/"), "a@sfu.ca", NOW);
      expect(r.pass === false && r.response.status).toBe(500);
    }
  });

  it("treats the control link and the bridge as the write paths", () => {
    expect(needsControl(route("/rb1/control"))).toBe(true);
    expect(needsControl(route("/rb1/bridge"))).toBe(true);
    for (const p of ["/rb1/ws", "/rb1/camera/x", "/rb1/simple/", "/rb1/check", "/rb1/access"]) expect(needsControl(route(p))).toBe(false);
  });
});

describe("cookie renewal through OnePortal", () => {
  const RENEW_ENV = { ...ENV, ACCESS_CLIENT_ID: "id.access", ACCESS_CLIENT_SECRET: "s".repeat(64) };
  const expiredCookie = (over: Partial<{ email: string; car: string }> = {}, ago = 60_000) =>
    cookieFor("view", over, NOW - COOKIE_TTL_MS - ago);
  function oneportal(answer: (body: { email: string; car: string }) => Response | Promise<Response>) {
    const calls: { url: string; headers: Headers; body: { email: string; car: string } }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, headers: new Headers(init.headers), body });
      return answer(body);
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }
  const passResponse = (p: string) => new Response(JSON.stringify({ pass: p }), { headers: { "Content-Type": "application/json" } });

  it("renews an expired cookie at the person's current role and sets a new cookie", async () => {
    const op = oneportal(() => passResponse(pass({ role: "control" })));
    const r = await gate(req("/rb1/ws", { Cookie: await expiredCookie() }), RENEW_ENV, route("/rb1/ws"), "a@sfu.ca", NOW, op.fetcher);
    expect(r.pass && r.role).toBe("control");
    expect(r.pass && r.setCookie).toMatch(/^op_rb1=[\w-]+\.[\w-]+; Path=\/rb1\/;/);
    expect(op.calls).toHaveLength(1);
    expect(op.calls[0].url).toBe(`${ORIGIN}/api/dashboard-renew`);
    expect(op.calls[0].body).toEqual({ email: "a@sfu.ca", car: "rb1" });
    expect(op.calls[0].headers.get("CF-Access-Client-Id")).toBe("id.access");
  });

  it("fails closed when OnePortal refuses, is down, or answers with a pass it did not sign or for someone else", async () => {
    const answers = [
      () => new Response("no", { status: 403 }),
      () => { throw new Error("down"); },
      () => passResponse(pass({ role: "control" }, other.privateKey)),
      () => passResponse(pass({ role: "control", email: "b@sfu.ca" })),
      () => passResponse(pass({ role: "control", car: "rb2" })),
      () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
    ];
    for (const answer of answers) {
      const op = oneportal(answer);
      const r = await gate(req("/rb1/control", { Cookie: await expiredCookie() }), RENEW_ENV, route("/rb1/control"), "a@sfu.ca", NOW, op.fetcher);
      expect(r.pass).toBe(false);
    }
  });

  it("does not ask OnePortal without a renewable cookie of this person and car, or without the service token", async () => {
    const op = oneportal(() => passResponse(pass({ role: "control" })));
    const cases: [string, string, Record<string, string | undefined>][] = [
      ["", "a@sfu.ca", RENEW_ENV],
      [await expiredCookie({}, RENEW_WINDOW_MS + 1), "a@sfu.ca", RENEW_ENV],
      [await expiredCookie(), "b@sfu.ca", RENEW_ENV],
      [(await expiredCookie({ car: "rb2" })).replace("op_rb2", "op_rb1"), "a@sfu.ca", RENEW_ENV],
      [`op_rb1=${"x".repeat(20)}.${"y".repeat(20)}`, "a@sfu.ca", RENEW_ENV],
      [await expiredCookie(), "a@sfu.ca", ENV],
    ];
    for (const [Cookie, user, env] of cases) {
      const r = await gate(req("/rb1/control", Cookie ? { Cookie } : {}), env, route("/rb1/control"), user, NOW, op.fetcher);
      expect(r.pass).toBe(false);
    }
    expect(op.calls).toHaveLength(0);
  });

  it("does not renew a cookie that is still valid", async () => {
    const op = oneportal(() => passResponse(pass({ role: "control" })));
    const r = await gate(req("/rb1/control", { Cookie: await cookieFor("view") }), RENEW_ENV, route("/rb1/control"), "a@sfu.ca", NOW, op.fetcher);
    expect(r).toEqual({ pass: true, role: "view", via: "oneportal" });
    expect(op.calls).toHaveLength(0);
  });
});

describe("lichtblickDeepLink", () => {
  it("adds the car's bridge as the data source, once", () => {
    const deep = lichtblickDeepLink(new URL("https://dashboard.sfuracerbot.ca/rb2/advanced/"), "rb2")!;
    const u = new URL(deep);
    expect(u.pathname).toBe("/rb2/advanced/");
    expect(u.searchParams.get("ds")).toBe("foxglove-websocket");
    expect(u.searchParams.get("ds.url")).toBe("wss://dashboard.sfuracerbot.ca/rb2/bridge");
    expect(lichtblickDeepLink(u, "rb2")).toBeNull();
    expect(new URL(lichtblickDeepLink(new URL("http://localhost:8787/rb1/advanced/"), "rb1")!).searchParams.get("ds.url")).toBe("ws://localhost:8787/rb1/bridge");
  });
});
