import { describe, expect, it } from "vitest";
import { accessUser, isStripped, originRequestHeaders } from "../src/headers";

const TOKEN = { clientId: "abc.access", clientSecret: "cfast_s3cret" };

function browser(extra: Record<string, string> = {}): Headers {
  return new Headers({
    Origin: "https://dashboard.sfuracerbot.ca",
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "foxglove.sdk.v1, foxglove.websocket.v1",
    "Sec-WebSocket-Version": "13",
    "User-Agent": "test",
    ...extra,
  });
}

describe("originRequestHeaders", () => {
  it("adds the service token", () => {
    const out = originRequestHeaders(browser(), TOKEN);
    expect(out.get("CF-Access-Client-Id")).toBe("abc.access");
    expect(out.get("CF-Access-Client-Secret")).toBe("cfast_s3cret");
  });

  it("passes Origin and every WebSocket header through unchanged", () => {
    const out = originRequestHeaders(browser(), TOKEN);
    expect(out.get("Origin")).toBe("https://dashboard.sfuracerbot.ca");
    expect(out.get("Upgrade")).toBe("websocket");
    expect(out.get("Sec-WebSocket-Protocol")).toBe("foxglove.sdk.v1, foxglove.websocket.v1");
    expect(out.get("Sec-WebSocket-Version")).toBe("13");
  });

  it("sets role and user only when asked", () => {
    const control = originRequestHeaders(browser(), { ...TOKEN, role: "control", user: "a@sfu.ca" });
    expect(control.get("X-Racerbot-Role")).toBe("control");
    expect(control.get("X-Racerbot-User")).toBe("a@sfu.ca");
    const bridge = originRequestHeaders(browser(), { ...TOKEN, user: "a@sfu.ca" });
    expect(bridge.get("X-Racerbot-Role")).toBeNull();
    const relay = originRequestHeaders(browser(), { ...TOKEN, role: "relay" });
    expect(relay.get("X-Racerbot-User")).toBeNull();
  });

  it("deletes a browser-supplied X-Racerbot-User and X-Racerbot-Role, in any case", () => {
    const forged = browser({ "X-Racerbot-User": "boss@sfu.ca", "x-racerbot-role": "control", "X-RACERBOT-OTHER": "1" });
    // Bridge/camera: no role, so a forged one must not survive by default.
    const bridge = originRequestHeaders(forged, { ...TOKEN, user: "real@sfu.ca" });
    expect(bridge.get("X-Racerbot-User")).toBe("real@sfu.ca");
    expect(bridge.get("X-Racerbot-Role")).toBeNull();
    expect(bridge.get("X-Racerbot-Other")).toBeNull();
    // Relay: no user, so a forged one must not survive either.
    const relay = originRequestHeaders(forged, { ...TOKEN, role: "relay" });
    expect(relay.get("X-Racerbot-User")).toBeNull();
    expect(relay.get("X-Racerbot-Role")).toBe("relay");
  });

  it("replaces a browser-supplied service token rather than forwarding it", () => {
    const forged = browser({ "CF-Access-Client-Id": "evil", "CF-Access-Client-Secret": "evil" });
    const out = originRequestHeaders(forged, TOKEN);
    expect(out.get("CF-Access-Client-Id")).toBe("abc.access");
    expect(out.get("CF-Access-Client-Secret")).toBe("cfast_s3cret");
  });

  it("never forwards the user's own Access credentials to the car", () => {
    const out = originRequestHeaders(browser({
      Cookie: "CF_Authorization=jwt",
      "Cf-Access-Jwt-Assertion": "jwt",
      "Cf-Access-Authenticated-User-Email": "a@sfu.ca",
      Authorization: "Bearer x",
    }), TOKEN);
    for (const name of ["Cookie", "Cf-Access-Jwt-Assertion", "Cf-Access-Authenticated-User-Email", "Authorization"]) {
      expect(out.get(name), name).toBeNull();
    }
  });

  it("isStripped is case-insensitive", () => {
    expect(isStripped("X-RaCeRbOt-UsEr")).toBe(true);
    expect(isStripped("COOKIE")).toBe(true);
    expect(isStripped("Origin")).toBe(false);
    expect(isStripped("Sec-WebSocket-Protocol")).toBe(false);
  });
});

describe("accessUser", () => {
  it("reads the Access email header", () => {
    expect(accessUser(new Headers({ "Cf-Access-Authenticated-User-Email": " a@sfu.ca " }))).toBe("a@sfu.ca");
    expect(accessUser(new Headers())).toBeNull();
    expect(accessUser(new Headers({ "Cf-Access-Authenticated-User-Email": "  " }))).toBeNull();
  });
});
