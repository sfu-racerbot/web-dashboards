// CarRelay: one Durable Object per car (env.CAR_RELAY.getByName(carId)).
//
// It holds ONE WebSocket to the car's dashboard_node, as role=relay, and
// fans everything the car sends out to every viewer. However many people
// watch, the car sends each stream once, over its own uplink, once.
//
//   viewers  <--(hibernatable WebSockets)--  CarRelay  --(one outbound WebSocket)-->  car
//
// Lifecycle, and why nothing keeps it awake with nobody watching:
//   - The first viewer opens the car connection.
//   - While any viewer remains, a dropped car connection is retried with
//     exponential backoff (1 s, 2 s, 4 s ... 30 s).
//   - UPSTREAM_IDLE_SEC after the last viewer leaves, the car connection is
//     closed and the alarm cleared. With no outbound socket, no alarm and
//     no viewers, the runtime is free to evict the object.
// Timers are Durable Object alarms rather than setTimeout, so they survive
// the object being evicted between them (an alarm wakes it back up).
//
// Viewer sockets use the Hibernation API (ctx.acceptWebSocket). An
// outbound WebSocket cannot hibernate and keeps the object in memory, so
// the object is billed for duration exactly while the car is connected --
// which is exactly while someone is watching, plus the idle grace period.

import { DurableObject } from "cloudflare:workers";
import { LateJoinerCache, shouldBroadcast, type Outgoing } from "./cache";
import { CAR_WS_PATH, parseCars, serviceToken, upstreamIdleMs, type Env } from "./config";
import { Framer } from "./framing";
import {
  RELAY_PING, RELAY_PONG, earliest, mapCleared, nextBackoff, relayError, relayStatus,
} from "./relay-messages";

/** A viewer that has pinged before but not for this long is treated as dead. */
const VIEWER_SILENT_MS = 45_000;
/** How often the relay looks for dead viewers while traffic is flowing. */
const CULL_EVERY_MS = 5_000;

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export class CarRelay extends DurableObject<Env> {
  private upstream: WebSocket | null = null;
  private connecting = false;
  private framer = new Framer();
  private cache = new LateJoinerCache();
  private carConnected = false;
  private since: number | null = null;
  private upstreamError: string | undefined;
  private attempt = 0;
  private reconnectAt: number | null = null;
  private idleCloseAt: number | null = null;
  private lastCull = 0;
  private upstreamOpenedAt = 0;
  private upstreamMessages = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime itself, without waking the object: the page's
    // heartbeat costs no duration. getWebSocketAutoResponseTimestamp() then
    // tells us when each viewer last pinged.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG));
  }

  private get car(): string {
    return this.ctx.id.name ?? "unknown";
  }

  // ---------------------------------------------------------------------------
  // Viewers
  // ---------------------------------------------------------------------------

  /** Open viewer sockets, optionally not counting one that is on its way out. */
  private viewers(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  private statusText(except?: WebSocket): string {
    return JSON.stringify(relayStatus(this.carConnected, this.viewers(except).length, this.since, this.upstreamError));
  }

  /** For /api/cars. */
  async status(): Promise<{ car_connected: boolean; viewers: number; since: number | null; error?: string }> {
    const { type: _type, ...rest } = relayStatus(this.carConnected, this.viewers().length, this.since, this.upstreamError);
    return rest;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joinedAt: Date.now() });

    // Catch this viewer up, relay status first, then exactly what the car
    // would have sent a new connection itself.
    this.sendTo(server, [this.statusText(), ...this.cache.replay()]);

    this.idleCloseAt = null;
    this.viewersChanged("join");
    this.ensureUpstream();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The relay may have been evicted since the car connection dropped;
    // anything that wakes it with viewers present re-establishes it.
    this.ensureUpstream();
    if (typeof message !== "string") {
      ws.send(relayError(this.car, "binary"));
      return;
    }
    let parsed: { type?: unknown; action?: unknown } = {};
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.send(relayError(this.car, "not-json"));
      return;
    }
    if (parsed.type === "relay_ping") {
      // Normally answered by the auto-response; only a ping spelled
      // differently reaches here.
      ws.send(RELAY_PONG);
      return;
    }
    if (parsed.type === "map_control" && parsed.action === "clear_view") {
      // Not a write: the page forgetting its own copy of the map. Answered
      // the way the car answers it (dashboard_node.send_map_keyframe), from
      // the map the relay already holds. Nothing goes to the car.
      this.sendTo(ws, [mapCleared(this.cache.hasMap()), ...this.cache.mapReplay()]);
      return;
    }
    // Browser -> relay messages are never forwarded to the car. The relay
    // connection is shared and the car refuses writes on it anyway.
    ws.send(relayError(this.car, String(parsed.type ?? "")));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed: the runtime replies to the close frame itself.
    }
    this.viewersChanged("leave", ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.viewersChanged("error", ws);
  }

  private viewersChanged(kind: string, leaving?: WebSocket): void {
    const count = this.viewers(leaving).length;
    log("viewers", { car: this.car, change: kind, viewers: count });
    this.broadcastText(this.statusText(leaving), leaving);
    if (count === 0) {
      // Nobody left to reconnect for; close the car link after the grace
      // period (a page reload should not cost a reconnect).
      this.reconnectAt = null;
      this.idleCloseAt = this.upstream || this.connecting ? Date.now() + upstreamIdleMs(this.env) : null;
      if (this.idleCloseAt !== null && upstreamIdleMs(this.env) === 0) this.closeUpstream("idle");
    }
    this.scheduleAlarm();
  }

  private sendTo(ws: WebSocket, items: Outgoing[]): boolean {
    try {
      for (const item of items) ws.send(item);
      return true;
    } catch {
      // A socket we cannot send to is gone; drop it rather than leave a
      // half-sent header/binary pair behind for its reconnect to inherit.
      try {
        ws.close(1011, "send failed");
      } catch { /* already closed */ }
      return false;
    }
  }

  private broadcastText(text: string, except?: WebSocket): void {
    for (const ws of this.viewers(except)) this.sendTo(ws, [text]);
  }

  /**
   * Send to every viewer. ws.send() queues the message on that viewer's own
   * socket and returns at once (workerd keeps an outgoing queue and pump per
   * socket), so a slow viewer delays nobody else. What it cannot do is stop
   * a dead viewer's queue from growing; that is what cullSilentViewers is for.
   */
  private broadcast(items: Outgoing[]): void {
    for (const ws of this.viewers()) this.sendTo(ws, items);
  }

  /** Close viewers whose heartbeat stopped (pinged before, then went quiet). */
  private cullSilentViewers(now: number): void {
    if (now - this.lastCull < CULL_EVERY_MS) return;
    this.lastCull = now;
    for (const ws of this.viewers()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (last && now - last.getTime() > VIEWER_SILENT_MS) {
        log("viewer_dropped", { car: this.car, reason: "heartbeat stopped", silent_ms: now - last.getTime() });
        try {
          ws.close(4000, "no heartbeat");
        } catch { /* already closed */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The car connection
  // ---------------------------------------------------------------------------

  private ensureUpstream(): void {
    if (this.upstream || this.connecting) return;
    if (this.viewers().length === 0) return;
    if (this.reconnectAt !== null && Date.now() < this.reconnectAt) {
      this.scheduleAlarm();
      return;
    }
    this.reconnectAt = null;
    void this.connectUpstream();
  }

  private upstreamFailed(error: string): void {
    this.upstreamError = error;
    const backoff = nextBackoff(this.attempt);
    this.attempt = backoff.attempt;
    this.reconnectAt = Date.now() + backoff.delayMs;
    log("upstream_failed", { car: this.car, error, attempt: this.attempt, retry_in_ms: backoff.delayMs });
    this.broadcastText(this.statusText());
    this.scheduleAlarm();
  }

  private async connectUpstream(): Promise<void> {
    this.connecting = true;
    try {
      const token = serviceToken(this.env);
      if (!token.ok) return this.upstreamFailed(`secret ${token.missing} is not set on the Worker`);
      let car;
      try {
        car = parseCars(this.env.CARS).get(this.car);
      } catch (err) {
        return this.upstreamFailed(`car config error: ${(err as Error).message}`);
      }
      if (!car) return this.upstreamFailed(`car ${this.car} is not in the config`);

      const url = `${car.dash_origin}${CAR_WS_PATH}?role=relay`;
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Upgrade: "websocket",
            "CF-Access-Client-Id": token.id,
            "CF-Access-Client-Secret": token.secret,
            "X-Racerbot-Role": "relay",
            // The relay has no browser behind it; it presents the site's own
            // origin, which the car allows.
            Origin: this.env.PUBLIC_ORIGIN,
          },
        });
      } catch (err) {
        return this.upstreamFailed(`car ${this.car} unreachable: ${(err as Error).message}`);
      }
      const ws = response.webSocket;
      if (!ws) {
        return this.upstreamFailed(`car ${this.car} unreachable: its origin answered HTTP ${response.status}`);
      }
      ws.binaryType = "arraybuffer";
      ws.accept();
      if (this.viewers().length === 0 && this.idleCloseAt === null) {
        // Everyone left while we were connecting.
        this.idleCloseAt = Date.now() + upstreamIdleMs(this.env);
      }
      this.upstream = ws;
      this.carConnected = true;
      this.since = Date.now();
      this.upstreamError = undefined;
      this.attempt = 0;
      this.framer.reset();
      this.cache.clear();
      this.upstreamOpenedAt = Date.now();
      this.upstreamMessages = 0;
      ws.addEventListener("message", (event) => {
        if (this.upstream === ws) this.onUpstreamMessage(event.data as string | ArrayBuffer);
      });
      ws.addEventListener("close", (event) => {
        if (this.upstream === ws) this.onUpstreamClosed(event.code, event.reason);
      });
      ws.addEventListener("error", () => {
        if (this.upstream === ws) this.onUpstreamClosed(1006, "error");
      });
      log("upstream_connect", { car: this.car, viewers: this.viewers().length });
      this.broadcastText(this.statusText());
      this.scheduleAlarm();
    } finally {
      this.connecting = false;
    }
  }

  private onUpstreamMessage(data: string | ArrayBuffer): void {
    this.upstreamMessages++;
    const { units, problem } = this.framer.push(data);
    if (problem) log("upstream_frame_dropped", { car: this.car, problem, desyncs: this.framer.desyncs });
    for (const unit of units) {
      const note = this.cache.ingest(unit);
      if (note) log("map_cache", { car: this.car, note, drops: this.cache.mapDrops });
      if (!shouldBroadcast(unit)) continue;
      this.broadcast(unit.binary ? [unit.text, unit.binary] : [unit.text]);
    }
    this.cullSilentViewers(Date.now());
  }

  private onUpstreamClosed(code: number, reason: string): void {
    const uptime = Date.now() - this.upstreamOpenedAt;
    log("upstream_disconnect", {
      car: this.car, code, reason, uptime_ms: uptime, messages: this.upstreamMessages,
      messages_per_sec: uptime > 0 ? Math.round((this.upstreamMessages / uptime) * 10000) / 10 : 0,
    });
    this.upstream = null;
    this.carConnected = false;
    this.since = Date.now();
    // A reconnected car sends its whole catch-up again; nothing from this
    // connection should be handed to a viewer joining in between.
    this.cache.clear();
    this.framer.reset();
    if (this.viewers().length > 0) {
      this.upstreamFailed(`car connection closed (${code}${reason ? ` ${reason}` : ""})`);
    } else {
      this.broadcastText(this.statusText());
      this.idleCloseAt = null;
      this.scheduleAlarm();
    }
  }

  private closeUpstream(why: string): void {
    const ws = this.upstream;
    if (!ws) return;
    const uptime = Date.now() - this.upstreamOpenedAt;
    this.upstream = null;
    this.carConnected = false;
    this.since = Date.now();
    this.cache.clear();
    this.framer.reset();
    this.idleCloseAt = null;
    try {
      ws.close(1000, why);
    } catch { /* already closed */ }
    log("upstream_disconnect", {
      car: this.car, code: 1000, reason: why, uptime_ms: uptime, messages: this.upstreamMessages,
      messages_per_sec: uptime > 0 ? Math.round((this.upstreamMessages / uptime) * 10000) / 10 : 0,
    });
  }

  // ---------------------------------------------------------------------------
  // The one alarm: reconnect, or idle close, whichever is due first
  // ---------------------------------------------------------------------------

  private scheduleAlarm(): void {
    const next = earliest(this.reconnectAt, this.idleCloseAt);
    if (next === null) {
      void this.ctx.storage.deleteAlarm();
    } else {
      void this.ctx.storage.setAlarm(next);
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    if (this.idleCloseAt !== null && now >= this.idleCloseAt) {
      this.idleCloseAt = null;
      if (this.viewers().length === 0) this.closeUpstream("idle");
    }
    if (this.reconnectAt !== null && now >= this.reconnectAt) this.reconnectAt = null;
    // Also covers waking after eviction, when every in-memory deadline was
    // lost: viewers present and no car link means connect now.
    this.ensureUpstream();
    this.scheduleAlarm();
  }
}
