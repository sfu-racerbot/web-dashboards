// Passing a browser's request through to one of the car's origins.
//
// The target is built from config only: the car's origin plus a fixed path
// (or, for the camera, the path under /<car>/camera/). Nothing in the
// request can choose the host.

import { accessUser, originRequestHeaders, type Role } from "./headers";

export interface PassthroughOptions {
  car: string;
  target: string;
  clientId: string;
  clientSecret: string;
  role?: Role;
  user?: string;
}

/** Why a car origin refused, when Cloudflare itself (not the car) did the refusing. */
export function refusalReason(response: Response): string {
  if (response.headers.get("cf-mitigated") === "challenge") {
    return "a Cloudflare WAF/bot challenge on the car's hostname blocked the site (see /<car>/check)";
  }
  return `its origin answered HTTP ${response.status}`;
}

/** Cloudflare's own "could not reach the origin" answers (tunnel down, etc.). */
function isEdgeOriginFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

export function unreachable(car: string, detail: string): Response {
  return new Response(`car ${car} unreachable: ${detail}\n`, {
    status: 502,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function outgoing(request: Request, opts: PassthroughOptions): Request {
  return new Request(opts.target, {
    method: request.method,
    headers: originRequestHeaders(request.headers, opts),
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "manual",
  });
}

/**
 * WebSocket passthrough with no JavaScript in the data path: the car's
 * 101 response (its WebSocket, and its Sec-WebSocket-Protocol) is handed
 * straight back to the browser, and the runtime joins the two sockets.
 * Frames never touch the Worker's CPU, which is what makes an hour-long
 * Lichtblick session possible on the Workers Free plan's 10 ms per request.
 */
export async function passthroughWebSocket(request: Request, opts: PassthroughOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(outgoing(request, opts));
  } catch (err) {
    return unreachable(opts.car, (err as Error).message);
  }
  if (response.status !== 101 || !response.webSocket) {
    return unreachable(opts.car, `${refusalReason(response)} instead of a WebSocket`);
  }
  return response;
}

/**
 * HTTP passthrough, streamed: the body is returned as the car sends it and
 * never read here, so a never-ending MJPEG stream flows frame by frame and
 * costs the Worker no CPU after the headers.
 */
export async function passthroughHttp(request: Request, opts: PassthroughOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(outgoing(request, opts));
  } catch (err) {
    return unreachable(opts.car, (err as Error).message);
  }
  if (isEdgeOriginFailure(response.status) || response.headers.get("cf-mitigated") === "challenge") {
    return unreachable(opts.car, refusalReason(response));
  }
  return response;
}

export interface BridgeLog {
  user: string;
  car: string;
  connected_at: string;
  disconnected_at: string | null;
  close_code: number | null;
  tracking: "native" | "relay";
}

/**
 * The bridge, with its connection logged as
 * {user, car, connected_at, disconnected_at, close_code}. Messages are never
 * inspected, in either mode.
 *
 * "native" (the default): passthroughWebSocket. The Worker is not in the
 * data path, so it never learns when the socket closes: disconnected_at and
 * close_code are logged as null. See docs/decisions.md for why this is the
 * default on the Free plan.
 *
 * "relay": the Worker accepts both sockets and copies frames between them,
 * so it sees the close. Every frame then runs Worker JavaScript, which on
 * the Free plan's 10 ms CPU per request ends a busy Lichtblick session
 * within seconds. Use only on Workers Paid.
 */
export async function bridge(
  request: Request,
  opts: PassthroughOptions & { tracking: "native" | "relay" },
): Promise<Response> {
  const entry: BridgeLog = {
    user: opts.user ?? "unknown",
    car: opts.car,
    connected_at: new Date().toISOString(),
    disconnected_at: null,
    close_code: null,
    tracking: opts.tracking,
  };
  if (opts.tracking !== "relay") {
    const response = await passthroughWebSocket(request, opts);
    if (response.status === 101) console.log(JSON.stringify({ event: "bridge_connect", ...entry }));
    return response;
  }

  let response: Response;
  try {
    response = await fetch(outgoing(request, opts));
  } catch (err) {
    return unreachable(opts.car, (err as Error).message);
  }
  const upstream = response.webSocket;
  if (response.status !== 101 || !upstream) {
    return unreachable(opts.car, `${refusalReason(response)} instead of a WebSocket`);
  }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept({ allowHalfOpen: true });
  server.accept({ allowHalfOpen: true });
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    entry.disconnected_at = new Date().toISOString();
    entry.close_code = code;
    console.log(JSON.stringify({ event: "bridge_disconnect", ...entry }));
  };
  upstream.addEventListener("message", (e) => server.send(e.data as string | ArrayBuffer));
  server.addEventListener("message", (e) => upstream.send(e.data as string | ArrayBuffer));
  const closeBoth = (code: number, reason: string) => {
    finish(code);
    for (const ws of [server, upstream]) {
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      } catch { /* already closed */ }
    }
  };
  upstream.addEventListener("close", (e) => closeBoth(e.code, e.reason));
  server.addEventListener("close", (e) => closeBoth(e.code, e.reason));
  upstream.addEventListener("error", () => closeBoth(1011, "upstream error"));
  server.addEventListener("error", () => closeBoth(1011, "browser error"));
  console.log(JSON.stringify({ event: "bridge_connect", ...entry }));
  const headers = new Headers();
  const protocol = response.headers.get("Sec-WebSocket-Protocol");
  if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  return new Response(null, { status: 101, webSocket: client, headers });
}

export { accessUser };
