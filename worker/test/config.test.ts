import { describe, expect, it } from "vitest";
import { ConfigError, parseCars, serviceToken, tokenShape, upstreamIdleMs } from "../src/config";

const RB2 = {
  name: "Car 2",
  dash_origin: "https://rb2-dash-origin.sfuracerbot.ca",
  bridge_origin: "https://rb2-bridge-origin.sfuracerbot.ca",
  cam_origin: "https://rb2-cam-origin.sfuracerbot.ca",
};

describe("parseCars", () => {
  it("reads the object form wrangler.jsonc gives", () => {
    const cars = parseCars({ rb2: RB2 });
    expect(cars.get("rb2")).toEqual(RB2);
    expect(cars.get("rb3")).toBeUndefined();
  });

  it("reads the JSON-string form .dev.vars gives", () => {
    expect(parseCars(JSON.stringify({ rb2: RB2 })).get("rb2")?.name).toBe("Car 2");
  });

  it("adding a car is adding an entry", () => {
    const rb3 = { ...RB2, name: "Car 3", dash_origin: "https://rb3-dash-origin.sfuracerbot.ca" };
    const cars = parseCars({ rb2: RB2, rb3 });
    expect([...cars.keys()]).toEqual(["rb2", "rb3"]);
    expect(cars.get("rb3")?.dash_origin).toBe("https://rb3-dash-origin.sfuracerbot.ca");
  });

  it("allows plain http only for localhost (the mock car)", () => {
    const local = { ...RB2, dash_origin: "http://localhost:8090", bridge_origin: "http://127.0.0.1:8765", cam_origin: "http://localhost:8090" };
    expect(parseCars({ rb2: local }).get("rb2")?.dash_origin).toBe("http://localhost:8090");
    expect(() => parseCars({ rb2: { ...RB2, dash_origin: "http://rb2-dash-origin.sfuracerbot.ca" } })).toThrow(ConfigError);
  });

  it("insists on bare origins: no path, query or fragment", () => {
    for (const bad of ["https://x.sfuracerbot.ca/ws", "https://x.sfuracerbot.ca/?a=1", "https://x.sfuracerbot.ca/#x"]) {
      expect(() => parseCars({ rb2: { ...RB2, cam_origin: bad } }), bad).toThrow(/origin only/);
    }
    // A trailing slash is still a bare origin, and is normalised away.
    expect(parseCars({ rb2: { ...RB2, cam_origin: "https://x.sfuracerbot.ca/" } }).get("rb2")?.cam_origin)
      .toBe("https://x.sfuracerbot.ca");
  });

  it("names the car and the field when something is missing", () => {
    expect(() => parseCars({ rb2: { ...RB2, bridge_origin: undefined } })).toThrow("car rb2: bridge_origin is missing");
  });

  it("refuses car ids that could not appear in a path", () => {
    expect(() => parseCars({ "RB 2": RB2 })).toThrow(/not a valid car id/);
    expect(() => parseCars({ "../x": RB2 })).toThrow(/not a valid car id/);
  });

  it("refuses missing or malformed config", () => {
    expect(() => parseCars(undefined)).toThrow("CARS is not set");
    expect(() => parseCars("{nope")).toThrow(/not valid JSON/);
    expect(() => parseCars("[]")).toThrow(/must be an object/);
  });

  it("falls back to the id when a car has no name", () => {
    expect(parseCars({ rb2: { ...RB2, name: "" } }).get("rb2")?.name).toBe("rb2");
  });
});

describe("serviceToken", () => {
  it("names the first missing secret and never its value", () => {
    expect(serviceToken({})).toEqual({ ok: false, missing: "ACCESS_CLIENT_ID" });
    expect(serviceToken({ ACCESS_CLIENT_ID: "id.access" })).toEqual({ ok: false, missing: "ACCESS_CLIENT_SECRET" });
    expect(serviceToken({ ACCESS_CLIENT_ID: "", ACCESS_CLIENT_SECRET: "s" })).toEqual({ ok: false, missing: "ACCESS_CLIENT_ID" });
    const result = serviceToken({ ACCESS_CLIENT_ID: "id.access", ACCESS_CLIENT_SECRET: "cfast_secret" });
    expect(result).toEqual({ ok: true, id: "id.access", secret: "cfast_secret" });
  });
});

describe("upstreamIdleMs", () => {
  it("defaults to 60 s and honours the variable", () => {
    expect(upstreamIdleMs({})).toBe(60_000);
    expect(upstreamIdleMs({ UPSTREAM_IDLE_SEC: "5" })).toBe(5_000);
    expect(upstreamIdleMs({ UPSTREAM_IDLE_SEC: "0" })).toBe(0);
    expect(upstreamIdleMs({ UPSTREAM_IDLE_SEC: "junk" })).toBe(60_000);
    expect(upstreamIdleMs({ UPSTREAM_IDLE_SEC: "-3" })).toBe(60_000);
  });
});


describe("tokenShape", () => {
  const id = "0123456789abcdef0123456789abcdef.access";
  const secret = "cfast_" + "a".repeat(48);
  it("passes a real-looking pair and says nothing about the values", () => {
    expect(tokenShape(id, secret)).toEqual([]);
  });
  it("spots swapped values", () => {
    expect(tokenShape(secret, id).join(" ")).toMatch(/swapped/);
  });
  it("spots a Client ID that is not one, and a short secret", () => {
    expect(tokenShape("nope", secret).join(" ")).toMatch(/\.access/);
    expect(tokenShape(id, "short").join(" ")).toMatch(/only 5 characters/);
  });
  it("never echoes a value", () => {
    expect(tokenShape("abc-sensitive", "xyz-sensitive").join(" ")).not.toMatch(/sensitive/);
  });
  it("serviceToken trims pasted whitespace", () => {
    expect(serviceToken({ ACCESS_CLIENT_ID: ` ${id}\n`, ACCESS_CLIENT_SECRET: `${secret} ` })).toEqual({ ok: true, id, secret });
  });
});
