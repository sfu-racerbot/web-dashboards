import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/routes";

describe("parseRoute", () => {
  it("serves the landing page at /", () => {
    expect(parseRoute("/")).toEqual({ kind: "landing" });
    expect(parseRoute("/index.html")).toEqual({ kind: "landing" });
  });

  it("serves the status API", () => {
    expect(parseRoute("/api/cars")).toEqual({ kind: "api-cars" });
  });

  it("maps each dashboard onto its assets, adding index.html for folders", () => {
    expect(parseRoute("/rb2/simple/")).toEqual({ kind: "app", car: "rb2", app: "simple", assetPath: "/simple/index.html" });
    expect(parseRoute("/rb2/simple/dashboard.js")).toEqual({ kind: "app", car: "rb2", app: "simple", assetPath: "/simple/dashboard.js" });
    expect(parseRoute("/rb2/simple/camera.html")).toEqual({ kind: "app", car: "rb2", app: "simple", assetPath: "/simple/camera.html" });
    expect(parseRoute("/rb2/advanced/")).toEqual({ kind: "app", car: "rb2", app: "advanced", assetPath: "/advanced/index.html" });
    expect(parseRoute("/rb2/advanced/main.abc123.js")).toMatchObject({ assetPath: "/advanced/main.abc123.js" });
  });

  it("sends /<car>/simple to /<car>/simple/ so relative URLs resolve", () => {
    expect(parseRoute("/rb2/simple")).toEqual({ kind: "app-slash", car: "rb2", app: "simple" });
    expect(parseRoute("/rb2/advanced")).toEqual({ kind: "app-slash", car: "rb2", app: "advanced" });
  });

  it("recognises the three sockets exactly", () => {
    expect(parseRoute("/rb2/ws")).toEqual({ kind: "telemetry", car: "rb2" });
    expect(parseRoute("/rb2/control")).toEqual({ kind: "control", car: "rb2" });
    expect(parseRoute("/rb2/bridge")).toEqual({ kind: "bridge", car: "rb2" });
    expect(parseRoute("/rb2/ws/extra")).toEqual({ kind: "not-found" });
    expect(parseRoute("/rb2/control/")).toEqual({ kind: "not-found" });
  });

  it("passes any camera path through, including the stream", () => {
    expect(parseRoute("/rb2/camera/stream")).toEqual({ kind: "camera", car: "rb2", path: "stream" });
    expect(parseRoute("/rb2/camera/status/now")).toEqual({ kind: "camera", car: "rb2", path: "status/now" });
    expect(parseRoute("/rb2/camera/")).toEqual({ kind: "not-found" });
    expect(parseRoute("/rb2/camera")).toEqual({ kind: "not-found" });
  });

  it("gives the bare car path its own route", () => {
    expect(parseRoute("/rb2")).toEqual({ kind: "car-root", car: "rb2" });
    expect(parseRoute("/rb2/")).toEqual({ kind: "car-root", car: "rb2" });
  });

  it("refuses anything that is not a car id", () => {
    for (const path of ["/RB2/ws", "/-x/ws", "/%2e%2e/ws", "/api/ws", "/a_b/ws", "/" + "x".repeat(33) + "/ws"]) {
      // "api" IS a valid car id shape; it only fails later if not configured.
      if (path === "/api/ws") continue;
      expect(parseRoute(path), path).toEqual({ kind: "not-found" });
    }
  });

  it("refuses dot segments, even percent-encoded, anywhere after the car", () => {
    expect(parseRoute("/rb2/camera/%2e%2e/secret")).toEqual({ kind: "not-found" });
    expect(parseRoute("/rb2/simple/%2E%2E/x")).toEqual({ kind: "not-found" });
    expect(parseRoute("/rb2/camera/a%2fb")).toEqual({ kind: "not-found" });
    expect(parseRoute("/rb2/camera/%zz")).toEqual({ kind: "not-found" });
  });

  it("does not know other paths", () => {
    expect(parseRoute("/rb2/other")).toEqual({ kind: "not-found" });
    // A dot is not allowed in a car id, so a stray root file is a plain 404.
    expect(parseRoute("/favicon.ico")).toEqual({ kind: "not-found" });
  });
});
