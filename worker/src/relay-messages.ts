// Messages the relay itself sends to viewers. Every type starts with
// "relay_", a prefix no car message uses (the car's types are listed in
// cache.ts), so the page can never mistake one for the car talking.

export const RELAY_PING = '{"type":"relay_ping"}';
export const RELAY_PONG = '{"type":"relay_pong"}';

export interface RelayStatus {
  type: "relay_status";
  /** Does the relay currently hold a connection to the car? */
  car_connected: boolean;
  /** Viewers connected to this relay right now. */
  viewers: number;
  /** When car_connected last changed (ms since the epoch), or null if unknown. */
  since: number | null;
  /** Why the relay cannot reach the car, when it knows. Never a secret's value. */
  error?: string;
}

export function relayStatus(carConnected: boolean, viewers: number, since: number | null, error?: string): RelayStatus {
  const status: RelayStatus = { type: "relay_status", car_connected: carConnected, viewers, since };
  if (error) status.error = error;
  return status;
}

export function relayError(car: string, refusedType: string): string {
  return JSON.stringify({
    type: "relay_error",
    refused: refusedType.slice(0, 64),
    detail: `this socket is read-only telemetry shared by everyone watching; `
      + `send write actions to /${car}/control`,
  });
}

/** The answer to "clear the view", identical to the car's own map_cleared. */
export function mapCleared(hasMap: boolean): string {
  return JSON.stringify({ type: "map_cleared", has_map: hasMap, stamp: Date.now() / 1000 });
}

export interface Backoff {
  attempt: number;
  delayMs: number;
}

/** Exponential reconnect backoff: 1 s, 2 s, 4 s ... capped at 30 s, plus jitter. */
export function nextBackoff(attempt: number, random = Math.random): Backoff {
  const next = attempt + 1;
  const base = Math.min(30_000, 1_000 * 2 ** (next - 1));
  return { attempt: next, delayMs: base + Math.floor(random() * 250) };
}

/** The earliest of several optional deadlines, or null if there are none. */
export function earliest(...times: Array<number | null>): number | null {
  const set = times.filter((t): t is number => typeof t === "number");
  return set.length ? Math.min(...set) : null;
}
