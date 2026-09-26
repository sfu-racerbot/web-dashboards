// The Worker behind https://dashboard.sfuracerbot.ca.
//
// Static assets (the landing page, the simple dashboard, Lichtblick) are
// served by Workers Static Assets. This script runs for everything that is
// not a file on disk: the per-car routes, and /api/cars. The route table
// is in routes.ts; how each car origin is reached is in proxy.ts and
// relay.ts; the headers every car request carries are in headers.ts.
//
// Errors, deliberately plain text and specific:
//   unknown car        -> 404 naming it
//   car unreachable    -> 502 naming the car
//   missing secret     -> 500 naming the secret (never its value)

import { CAR_WS_PATH, ConfigError, parseCars, serviceToken, type CarConfig, type Env } from "./config";
import { accessUser } from "./headers";
import { bridge, passthroughHttp, passthroughWebSocket } from "./proxy";
import { parseRoute, type Route } from "./routes";

export { CarRelay } from "./relay";

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/** The Access-authenticated user, or null when there is none and none may be assumed. */
function userFor(request: Request, env: Env): string | null {
  const user = accessUser(request.headers);
  if (user) return user;
  // Only for `wrangler dev`, where there is no Access in front of the Worker.
  return env.ALLOW_ANONYMOUS_DEV === "1" ? "dev@localhost" : null;
}

/** Absolute ws(s):// URL of a car's bridge route, as the browser should dial it. */
function bridgeUrl(url: URL, car: string): string {
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/${car}/bridge`;
}

async function apiCars(url: URL, env: Env, cars: Map<string, CarConfig>): Promise<Response> {
  const list = await Promise.all([...cars.entries()].map(async ([id, car]) => {
    let status: Record<string, unknown>;
    try {
      const s = await env.CAR_RELAY.getByName(id).status();
      status = { car_connected: s.car_connected, viewers: s.viewers, since: s.since, ...(s.error ? { error: s.error } : {}) };
    } catch (err) {
      status = { car_connected: false, viewers: 0, since: null, error: `relay unavailable: ${(err as Error).message}` };
    }
    return {
      id,
      name: car.name,
      links: {
        simple: `/${id}/simple/`,
        camera: `/${id}/simple/camera.html`,
        advanced: `/${id}/advanced/?ds=foxglove-websocket&ds.url=${encodeURIComponent(bridgeUrl(url, id))}`,
      },
      status,
    };
  }));
  return new Response(JSON.stringify({ cars: list, generated_at: Date.now() }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route: Route = parseRoute(url.pathname);

  if (route.kind === "not-found") return text(404, "not found");
  if (route.kind === "landing") return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));

  let cars: Map<string, CarConfig>;
  try {
    cars = parseCars(env.CARS);
  } catch (err) {
    if (err instanceof ConfigError) return text(500, `site misconfigured: ${err.message}`);
    throw err;
  }

  if (route.kind === "api-cars") return apiCars(url, env, cars);

  const car = cars.get(route.car);
  if (!car) return text(404, `unknown car '${route.car}'`);

  switch (route.kind) {
    case "car-root":
      return Response.redirect(new URL("/", url).toString(), 302);
    case "app-slash":
      return Response.redirect(new URL(`/${route.car}/${route.app}/${url.search}`, url).toString(), 301);
    case "app": {
      const asset = await env.ASSETS.fetch(new Request(new URL(route.assetPath, url), request));
      if (asset.status === 404 && route.app === "advanced") {
        return text(404, "the advanced dashboard (Lichtblick) is not in this build -- see apps/advanced/README.md");
      }
      return asset;
    }
    default:
      break;
  }

  // Everything below reaches the car, so it needs the service token.
  const token = serviceToken(env);
  if (!token.ok) return text(500, `site misconfigured: secret ${token.missing} is not set on the Worker`);

  if (route.kind === "telemetry") {
    if (!isUpgrade(request)) return text(426, "expected a WebSocket upgrade");
    return env.CAR_RELAY.getByName(route.car).fetch(request);
  }

  const user = userFor(request, env);
  if (!user) return text(403, "no Cloudflare Access identity on this request");
  const base = { car: route.car, clientId: token.id, clientSecret: token.secret, user };

  switch (route.kind) {
    case "control":
      if (!isUpgrade(request)) return text(426, "expected a WebSocket upgrade");
      return passthroughWebSocket(request, {
        ...base, role: "control", target: `${car.dash_origin}${CAR_WS_PATH}?role=control`,
      });
    case "bridge":
      if (!isUpgrade(request)) return text(426, "expected a WebSocket upgrade");
      return bridge(request, {
        ...base,
        target: `${car.bridge_origin}/`,
        tracking: env.BRIDGE_TRACKING === "relay" ? "relay" : "native",
      });
    case "camera":
      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(405, "the camera is read-only", { Allow: "GET, HEAD" });
      }
      return passthroughHttp(request, { ...base, target: `${car.cam_origin}/${route.path}${url.search}` });
  }
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
