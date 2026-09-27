import { describe, expect, it } from "vitest";
import { cloudflareErrorCode, explain } from "../src/diagnose";
import { parseRoute } from "../src/routes";

describe("/<car>/check", () => {
  it("is a route", () => {
    expect(parseRoute("/rb2/check")).toEqual({ kind: "check", car: "rb2" });
  });

  it("reads Cloudflare's numbered error pages", () => {
    expect(cloudflareErrorCode("<title>Error 1033</title>")).toBe(1033);
    expect(cloudflareErrorCode("error code: 1016")).toBe(1016);
    expect(cloudflareErrorCode("hello")).toBeNull();
  });

  it("names the right fix for each failure", () => {
    expect(explain("dashboard", 302, "https://sfu.cloudflareaccess.com/cdn-cgi/access/login", null).fix).toMatch(/Service Auth/);
    expect(explain("dashboard", 403, null, null).fix).toMatch(/ACCESS_CLIENT_ID/);
    expect(explain("dashboard", 530, null, 1033).meaning).toMatch(/tunnel is not connected/);
    expect(explain("camera", 530, null, 1016).fix).toMatch(/route/);
    expect(explain("bridge", 502, null, null).fix).toMatch(/8765/);
    expect(explain("dashboard websocket", 404, null, null).fix).toMatch(/localhost:8080/);
  });

  it("recognises working answers", () => {
    expect(explain("dashboard websocket", 101, null, null).ok).toBe(true);
    expect(explain("dashboard", 200, null, null).ok).toBe(true);
    expect(explain("bridge", 400, null, null).ok).toBe(true);
    expect(explain("camera", 404, null, null).ok).toBe(true);
    expect(explain("dashboard", 500, null, null).ok).toBe(false);
  });
});
