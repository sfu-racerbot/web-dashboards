// The list of cars, and the few constants every part of the Worker shares.
//
// Cars live in ONE place: the CARS variable in wrangler.jsonc (an object),
// or, for local development, a JSON string in .dev.vars that overrides it.
// Adding a car is a config change and nothing else -- see
// docs/cloudflare-setup.md, "Adding a car".

import type { CarRelay } from "./relay";

export interface CarConfig {
  /** Shown on the landing page, e.g. "Car 2". */
  name: string;
  /** Tunnel hostname in front of the car's dashboard_node (car port 8080). */
  dash_origin: string;
  /** Tunnel hostname in front of the car's foxglove_bridge (car port 8765). */
  bridge_origin: string;
  /** Tunnel hostname in front of the car's usb_cam_stream (car port 9090). */
  cam_origin: string;
}

export interface Env {
  ASSETS: Fetcher;
  CAR_RELAY: DurableObjectNamespace<CarRelay>;
  /** Object (wrangler.jsonc) or JSON string (.dev.vars): car id -> CarConfig. */
  CARS: string | Record<string, CarConfig>;
  /** Service token the car origins' Access apps accept. Worker secrets. */
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  /** The Origin the relay presents to the car, e.g. https://dashboard.sfuracerbot.ca. */
  PUBLIC_ORIGIN: string;
  /** Seconds the relay keeps the car connection open after the last viewer leaves. */
  UPSTREAM_IDLE_SEC?: string;
  /** "native" (default) or "relay" -- how /<car>/bridge is proxied. See proxy.ts. */
  BRIDGE_TRACKING?: string;
  /** "1" only in .dev.vars: accept requests with no Access identity as dev@localhost. */
  ALLOW_ANONYMOUS_DEV?: string;
}

/** The dashboard_node WebSocket path on the car (dashboard_node.py make_app: r'/ws'). */
export const CAR_WS_PATH = "/ws";

/** Car ids are short lowercase config keys like "rb2"; nothing else is a car. */
export const CAR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const DEFAULT_UPSTREAM_IDLE_SEC = 60;

export class ConfigError extends Error {}

/**
 * An origin the Worker may send the service token to: https, no path, no
 * query. Plain http is accepted only for localhost, which is where
 * tools/mock-car runs during development.
 */
function checkOrigin(carId: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new ConfigError(`car ${carId}: ${field} is missing`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`car ${carId}: ${field} is not a URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConfigError(`car ${carId}: ${field} must be https:// (got ${value})`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ConfigError(`car ${carId}: ${field} must be an origin only, with no path (got ${value})`);
  }
  return url.origin;
}

/** Parse and validate the CARS variable. Throws ConfigError on anything wrong. */
export function parseCars(raw: Env["CARS"] | undefined): Map<string, CarConfig> {
  if (raw === undefined || raw === null || raw === "") throw new ConfigError("CARS is not set");
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`CARS is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ConfigError("CARS must be an object of car id -> car config");
  }
  const cars = new Map<string, CarConfig>();
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!CAR_ID_PATTERN.test(id)) throw new ConfigError(`car id ${JSON.stringify(id)} is not a valid car id`);
    if (typeof entry !== "object" || entry === null) throw new ConfigError(`car ${id}: config must be an object`);
    const e = entry as Record<string, unknown>;
    cars.set(id, {
      name: typeof e.name === "string" && e.name ? e.name : id,
      dash_origin: checkOrigin(id, "dash_origin", e.dash_origin),
      bridge_origin: checkOrigin(id, "bridge_origin", e.bridge_origin),
      cam_origin: checkOrigin(id, "cam_origin", e.cam_origin),
    });
  }
  return cars;
}

export function upstreamIdleMs(env: Pick<Env, "UPSTREAM_IDLE_SEC">): number {
  const sec = Number(env.UPSTREAM_IDLE_SEC);
  return (Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_UPSTREAM_IDLE_SEC) * 1000;
}

/**
 * The service token, or the name of the first secret that is missing.
 * The value of a secret is never put in an error message or a log.
 */
export function serviceToken(env: Pick<Env, "ACCESS_CLIENT_ID" | "ACCESS_CLIENT_SECRET">):
  { ok: true; id: string; secret: string } | { ok: false; missing: string } {
  if (!env.ACCESS_CLIENT_ID) return { ok: false, missing: "ACCESS_CLIENT_ID" };
  if (!env.ACCESS_CLIENT_SECRET) return { ok: false, missing: "ACCESS_CLIENT_SECRET" };
  return { ok: true, id: env.ACCESS_CLIENT_ID, secret: env.ACCESS_CLIENT_SECRET };
}
