import { describe, expect, it } from "vitest";
import { KNOWN_CAR_TYPES, LateJoinerCache, STATE_TYPES, shouldBroadcast } from "../src/cache";
import { Framer, type Unit } from "../src/framing";

/** Build units the way the relay does: through the framer. */
function units(...frames: Array<string | ArrayBuffer>): Unit[] {
  const f = new Framer();
  return frames.flatMap((frame) => f.push(frame).units);
}
const bin = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;
const j = (o: unknown) => JSON.stringify(o);

function texts(out: Array<string | ArrayBuffer>): string[] {
  return out.map((o) => (typeof o === "string" ? JSON.parse(o).type : `<${(o as ArrayBuffer).byteLength} bytes>`));
}

describe("LateJoinerCache", () => {
  it("replays hello first, then the map, the scan, and the latest of each state type", () => {
    const c = new LateJoinerCache();
    for (const u of units(
      j({ type: "stats", cpu_percent: 1 }),
      j({ type: "map", seq: 5, bytes: 10 }), bin(10),
      j({ type: "map_patch", seq: 6, bytes: 2 }), bin(2),
      j({ type: "scan", bytes: 4 }), bin(4),
      j({ type: "tuning", nodes: [] }),
      j({ type: "hello", protocol_version: 1 }),
      j({ type: "batch", items: [{ type: "pose", x: 1 }, { type: "speed", speed: 2 }, { type: "intent", intent: {} }] }),
      j({ type: "saved_maps", runs: [] }),
      j({ type: "processes", targets: [] }),
      j({ type: "racing_line", line: null }),
    )) c.ingest(u);
    expect(texts(c.replay())).toEqual([
      "hello",
      "map", "<10 bytes>", "map_patch", "<2 bytes>",
      "scan", "<4 bytes>",
      "pose", "speed", "intent", "racing_line", "stats", "tuning", "processes", "saved_maps",
    ]);
  });

  it("keeps only the newest of each state type, from batches or standalone", () => {
    const c = new LateJoinerCache();
    for (const u of units(
      j({ type: "batch", items: [{ type: "pose", x: 1 }] }),
      j({ type: "batch", items: [{ type: "pose", x: 2 }, { type: "stopwatch", elapsed_s: 3 }] }),
      j({ type: "stopwatch", elapsed_s: 4 }),
    )) c.ingest(u);
    const replayed = c.replay().map((o) => JSON.parse(o as string));
    expect(replayed).toEqual([{ type: "pose", x: 2 }, { type: "stopwatch", elapsed_s: 4 }]);
  });

  it("resets the map chain on every keyframe", () => {
    const c = new LateJoinerCache();
    for (const u of units(
      j({ type: "map", seq: 1, bytes: 1 }), bin(1),
      j({ type: "map_patch", seq: 2, bytes: 1 }), bin(1),
      j({ type: "map", seq: 3, bytes: 5 }), bin(5),
      j({ type: "map_patch", seq: 4, bytes: 1 }), bin(1),
    )) c.ingest(u);
    const seqs = c.mapReplay().filter((o) => typeof o === "string").map((o) => JSON.parse(o as string).seq);
    expect(seqs).toEqual([3, 4]);
  });

  it("drops the chain on a seq gap and waits for the next keyframe", () => {
    const c = new LateJoinerCache();
    const [key, p2, gap, next, later] = units(
      j({ type: "map", seq: 1, bytes: 1 }), bin(1),
      j({ type: "map_patch", seq: 2, bytes: 1 }), bin(1),
      j({ type: "map_patch", seq: 4, bytes: 1 }), bin(1),
      j({ type: "map_patch", seq: 5, bytes: 1 }), bin(1),
      j({ type: "map", seq: 6, bytes: 1 }), bin(1),
    );
    c.ingest(key);
    c.ingest(p2);
    expect(c.ingest(gap)).toMatch(/does not follow 2/);
    expect(c.hasMap()).toBe(false);
    expect(c.ingest(next)).toBeUndefined(); // no chain to extend; silently ignored
    expect(c.hasMap()).toBe(false);
    c.ingest(later);
    expect(c.hasMap()).toBe(true);
    expect(c.mapDrops).toBe(1);
  });

  it("hard-caps the map cache: on overflow it drops everything until the next keyframe", () => {
    const c = new LateJoinerCache(1000);
    const [key, p1, p2, key2] = units(
      j({ type: "map", seq: 1, bytes: 400 }), bin(400),
      j({ type: "map_patch", seq: 2, bytes: 300 }), bin(300),
      j({ type: "map_patch", seq: 3, bytes: 300 }), bin(300),
      j({ type: "map", seq: 4, bytes: 100 }), bin(100),
    );
    c.ingest(key);
    expect(c.ingest(p1)).toBeUndefined();
    expect(c.mapBytes()).toBeLessThanOrEqual(1000);
    expect(c.ingest(p2)).toMatch(/dropped until the next keyframe/);
    expect(c.hasMap()).toBe(false);
    expect(c.mapReplay()).toEqual([]);
    c.ingest(key2);
    expect(c.hasMap()).toBe(true);
  });

  it("refuses to cache a keyframe that alone exceeds the cap", () => {
    const c = new LateJoinerCache(50);
    const [key] = units(j({ type: "map", seq: 1, bytes: 100 }), bin(100));
    expect(c.ingest(key)).toMatch(/over the 50-byte cap/);
    expect(c.hasMap()).toBe(false);
  });

  it("ignores patches before any keyframe", () => {
    const c = new LateJoinerCache();
    c.ingest(units(j({ type: "map_patch", seq: 9, bytes: 1 }), bin(1))[0]);
    expect(c.replay()).toEqual([]);
  });

  it("never replays events or per-connection messages", () => {
    const c = new LateJoinerCache();
    for (const u of units(
      j({ type: "tuning_result", ok: true }),
      j({ type: "tuning_saved", ok: true }),
      j({ type: "process_result", ok: true }),
      j({ type: "map_delete_result", ok: true }),
      j({ type: "slam_reset_result", ok: true }),
      j({ type: "tuning_armed", armed: false }),
      j({ type: "map_cleared", has_map: true }),
      j({ type: "something_new" }),
    )) c.ingest(u);
    expect(c.replay()).toEqual([]);
  });

  it("clear() forgets everything (a new car connection)", () => {
    const c = new LateJoinerCache();
    for (const u of units(j({ type: "hello", protocol_version: 1 }), j({ type: "stats" }))) c.ingest(u);
    c.clear();
    expect(c.replay()).toEqual([]);
  });

  it("replays header and binary as the exact objects the car sent", () => {
    const c = new LateJoinerCache();
    const text = j({ type: "scan", bytes: 2, angle_min: -2.35 });
    const payload = bin(2, 42);
    c.ingest(units(text, payload)[0]);
    const out = c.replay();
    expect(out[0]).toBe(text);
    expect(new Uint8Array(out[1] as ArrayBuffer)).toEqual(new Uint8Array([42, 42]));
  });
});

describe("shouldBroadcast", () => {
  it("forwards everything except per-connection messages", () => {
    const [armed, stats, result] = units(j({ type: "tuning_armed", armed: false }), j({ type: "stats" }), j({ type: "tuning_result" }));
    expect(shouldBroadcast(armed)).toBe(false);
    expect(shouldBroadcast(stats)).toBe(true);
    expect(shouldBroadcast(result)).toBe(true);
  });
});

describe("the type lists", () => {
  it("cover every message type the car's protocol.py and mapstream.py define", () => {
    // From protocol.py and mapstream.py at car commit 022e6fa, plus hello
    // (the new contract). A new car type should be classified on purpose.
    const carTypes = [
      "map", "map_patch", "scan", "batch", "pose", "drive", "speed", "intent", "stopwatch", "stats",
      "racing_line", "tuning", "tuning_result", "tuning_saved", "tuning_armed", "processes",
      "process_result", "saved_maps", "map_delete_result", "slam_reset_result", "map_cleared", "hello",
    ];
    for (const t of carTypes) expect(KNOWN_CAR_TYPES.has(t), t).toBe(true);
    expect(STATE_TYPES).not.toContain("tuning_armed");
  });

  it("no relay message type can collide with a car type", () => {
    for (const t of KNOWN_CAR_TYPES) expect(t.startsWith("relay_"), t).toBe(false);
  });
});
