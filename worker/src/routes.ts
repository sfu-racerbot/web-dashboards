// Turning a request path into what the Worker should do with it. Pure: no
// config, no I/O -- whether the car exists is checked by the caller.
//
//   /                      landing page
//   /api/cars              JSON status for the landing page
//   /<car>/simple/...      simple dashboard (static assets under /simple/)
//   /<car>/advanced/...    Lichtblick (static assets under /advanced/)
//   /<car>/ws              telemetry WebSocket -> the car's relay (Durable Object)
//   /<car>/control         WebSocket passthrough -> the car's dashboard_node, role=control
//   /<car>/bridge          WebSocket passthrough -> the car's foxglove_bridge
//   /<car>/camera/<path>   HTTP passthrough -> the car's camera node
//   /<car>/check           JSON: which hop between the site and the car fails

import { CAR_ID_PATTERN } from "./config";

export type App = "simple" | "advanced";

export type Route =
  | { kind: "landing" }
  | { kind: "api-cars" }
  | { kind: "car-root"; car: string }
  | { kind: "app-slash"; car: string; app: App }
  | { kind: "app"; car: string; app: App; assetPath: string }
  | { kind: "telemetry"; car: string }
  | { kind: "control"; car: string }
  | { kind: "bridge"; car: string }
  | { kind: "camera"; car: string; path: string }
  | { kind: "check"; car: string }
  | { kind: "not-found" };

/** A path segment that could walk out of where it is put, even once decoded. */
function unsafeSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
}

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "/index.html") return { kind: "landing" };
  if (pathname === "/api/cars") return { kind: "api-cars" };

  const parts = pathname.split("/");
  // parts[0] is "" (the leading slash); parts[1] is the car.
  const car = parts[1] ?? "";
  if (!CAR_ID_PATTERN.test(car)) return { kind: "not-found" };
  const rest = parts.slice(2);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return { kind: "car-root", car };
  if (rest.slice(1).some(unsafeSegment)) return { kind: "not-found" };

  const [head, ...tail] = rest;
  if (head === "simple" || head === "advanced") {
    // /<car>/simple with no slash: relative asset URLs would resolve
    // against /<car>/, so send the browser to the slash form first.
    if (tail.length === 0) return { kind: "app-slash", car, app: head };
    const inner = tail.join("/");
    const file = inner === "" || inner.endsWith("/") ? `${inner}index.html` : inner;
    return { kind: "app", car, app: head, assetPath: `/${head}/${file}` };
  }
  if (tail.length === 0) {
    if (head === "ws") return { kind: "telemetry", car };
    if (head === "control") return { kind: "control", car };
    if (head === "bridge") return { kind: "bridge", car };
    if (head === "check") return { kind: "check", car };
  }
  if (head === "camera" && tail.length > 0 && tail.join("/") !== "") {
    return { kind: "camera", car, path: tail.join("/") };
  }
  return { kind: "not-found" };
}
