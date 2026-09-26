import { describe, expect, it } from "vitest";
import { earliest, mapCleared, nextBackoff, relayError, relayStatus, RELAY_PING, RELAY_PONG } from "../src/relay-messages";

describe("relay messages", () => {
  it("relay_status carries exactly the agreed fields", () => {
    expect(relayStatus(true, 3, 1000)).toEqual({ type: "relay_status", car_connected: true, viewers: 3, since: 1000 });
    expect(relayStatus(false, 0, null, "why")).toEqual({
      type: "relay_status", car_connected: false, viewers: 0, since: null, error: "why",
    });
  });

  it("relay_error points the page at /<car>/control", () => {
    const msg = JSON.parse(relayError("rb2", "tuning_control"));
    expect(msg.type).toBe("relay_error");
    expect(msg.refused).toBe("tuning_control");
    expect(msg.detail).toContain("/rb2/control");
  });

  it("map_cleared matches the car's own shape", () => {
    expect(JSON.parse(mapCleared(true))).toMatchObject({ type: "map_cleared", has_map: true });
  });

  it("the heartbeat is the exact string the page sends", () => {
    expect(JSON.parse(RELAY_PING)).toEqual({ type: "relay_ping" });
    expect(JSON.parse(RELAY_PONG)).toEqual({ type: "relay_pong" });
  });
});

describe("nextBackoff", () => {
  it("doubles from 1 s and caps at 30 s, with under 250 ms of jitter", () => {
    const zero = () => 0;
    const delays: number[] = [];
    let attempt = 0;
    for (let i = 0; i < 8; i++) {
      const b = nextBackoff(attempt, zero);
      attempt = b.attempt;
      delays.push(b.delayMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(nextBackoff(0, () => 0.999).delayMs).toBe(1249);
  });
});

describe("earliest", () => {
  it("ignores missing deadlines", () => {
    expect(earliest(null, null)).toBeNull();
    expect(earliest(5, null, 3)).toBe(3);
  });
});
