// What the relay remembers so a viewer who joins late sees the same thing
// as everyone else, straight away.
//
// On the car, dashboard_node.send_initial_state() catches each new browser
// up. The car now sees only ONE connection -- the relay's -- and sends that
// catch-up once, when the relay connects. From then on the relay has to do
// the car's job for every later viewer, from what it has seen go past.
//
// The list of what to remember is derived from dashboard_node.py and the
// car repo's README (recorded in docs/decisions.md):
//
//   hello                  the car's protocol version -- replayed FIRST,
//                          because the page decides "version 0" from
//                          whatever car message it sees first
//   map + map_patch        the latest keyframe and every patch since, in
//                          seq order (MapStreamer: a patch is only valid on
//                          top of exactly the frame before it)
//   scan                   the latest scan (header + binary)
//   pose, drive, speed,    the latest of each. On the wire they arrive inside
//   intent, stopwatch,     `batch` frames (batching.py); the relay unpacks the
//   stats                  batch and remembers each item, and replays them as
//                          standalone messages, as send_initial_state does
//   racing_line            latched on the car; sent on change and to new
//                          connections
//   tuning, processes,     whole-panel snapshots, sent on change and to new
//   saved_maps             connections (_last_*_json on the car)
//
// Deliberately NOT remembered:
//   tuning_armed           per connection. The relay's own is always
//                          "disarmed" and says nothing about any viewer, so
//                          it is not even forwarded (see shouldBroadcast)
//   map_cleared            a reply to one browser's "clear view"
//   tuning_result, tuning_saved, process_result, map_delete_result,
//   slam_reset_result      events: they describe one moment, and replaying
//                          one to a late joiner would report something that
//                          already happened as if it just had
//   batch                  never replayed as a batch; its items are
//                          remembered one by one instead

import type { Unit } from "./framing";

/** Replayed after hello, map and scan, in dashboard_node.send_initial_state's order. */
export const STATE_TYPES = [
  "pose", "drive", "speed", "intent", "racing_line", "stats", "stopwatch",
  "tuning", "processes", "saved_maps",
] as const;

const STATE_SET: ReadonlySet<string> = new Set(STATE_TYPES);

/** Only meaningful to one connection; never forwarded from the relay's own. */
export const PER_CONNECTION_TYPES: ReadonlySet<string> = new Set(["tuning_armed", "map_cleared"]);

/** Forwarded live, never replayed. */
export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "tuning_result", "tuning_saved", "process_result", "map_delete_result", "slam_reset_result",
]);

/** Every car message type this relay knows about; anything else is still forwarded. */
export const KNOWN_CAR_TYPES: ReadonlySet<string> = new Set([
  "hello", "map", "map_patch", "scan", "batch",
  ...STATE_TYPES, ...PER_CONNECTION_TYPES, ...EVENT_TYPES,
]);

/**
 * Default cap on the map cache: the keyframe plus every patch since it,
 * counted as header text plus binary bytes. A 2048x2048 keyframe is ~4 MB
 * uncompressed and ~24 kB deflated, and a patch is typically ~200 bytes,
 * so 16 MiB is room for an uncompressed keyframe and 30 s of patches many
 * times over, while staying a small slice of a Durable Object's 128 MB.
 */
export const DEFAULT_MAP_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** Messages the relay passes on to viewers. */
export function shouldBroadcast(unit: Unit): boolean {
  return !PER_CONNECTION_TYPES.has(unit.type);
}

export type Outgoing = string | ArrayBuffer;

interface MapCache {
  keyframe: Unit;
  patches: Unit[];
  lastSeq: number | null;
  bytes: number;
}

function unitBytes(unit: Unit): number {
  return unit.text.length + (unit.binary ? unit.binary.byteLength : 0);
}

export class LateJoinerCache {
  private hello: Unit | null = null;
  private map: MapCache | null = null;
  private scan: Unit | null = null;
  /** type -> the latest message of that type, as the JSON text to replay. */
  private state = new Map<string, string>();
  /** How many times the map cache has been dropped for size or a seq gap. */
  mapDrops = 0;

  constructor(private readonly maxMapBytes = DEFAULT_MAP_CACHE_MAX_BYTES) {}

  clear(): void {
    this.hello = null;
    this.map = null;
    this.scan = null;
    this.state.clear();
  }

  hasMap(): boolean {
    return this.map !== null;
  }

  mapBytes(): number {
    return this.map ? this.map.bytes : 0;
  }

  /**
   * Fold one unit from the car in. Returns a note for the log when the map
   * cache had to be dropped, and nothing otherwise.
   */
  ingest(unit: Unit): string | undefined {
    switch (unit.type) {
      case "hello":
        this.hello = unit;
        return undefined;
      case "map":
        // A keyframe replaces everything before it.
        this.map = {
          keyframe: unit,
          patches: [],
          lastSeq: typeof unit.header.seq === "number" ? unit.header.seq : null,
          bytes: unitBytes(unit),
        };
        if (this.map.bytes > this.maxMapBytes) {
          this.map = null;
          this.mapDrops++;
          return `map keyframe alone is ${unitBytes(unit)} bytes, over the ${this.maxMapBytes}-byte cap; not cached`;
        }
        return undefined;
      case "map_patch":
        return this.ingestPatch(unit);
      case "scan":
        this.scan = unit;
        return undefined;
      case "batch": {
        const items = Array.isArray(unit.header.items) ? unit.header.items : [];
        for (const item of items) {
          if (item && typeof item === "object" && STATE_SET.has(String((item as { type?: unknown }).type))) {
            this.state.set(String((item as { type: string }).type), JSON.stringify(item));
          }
        }
        return undefined;
      }
      default:
        if (STATE_SET.has(unit.type)) this.state.set(unit.type, unit.text);
        return undefined;
    }
  }

  private ingestPatch(unit: Unit): string | undefined {
    const map = this.map;
    if (!map) return undefined; // nothing to patch; wait for the next keyframe
    const seq = typeof unit.header.seq === "number" ? unit.header.seq : null;
    if (map.lastSeq === null || seq !== map.lastSeq + 1) {
      // A late joiner handed this chain would hit the same gap and wait for
      // a keyframe anyway; holding a chain nobody can apply is pointless.
      this.map = null;
      this.mapDrops++;
      return `map patch ${seq} does not follow ${map.lastSeq}; map cache dropped until the next keyframe`;
    }
    const size = unitBytes(unit);
    if (map.bytes + size > this.maxMapBytes) {
      // Over the cap. Dropping the whole chain (not just the oldest patch,
      // which would leave a chain that no longer starts at its keyframe)
      // means a viewer joining now gets no map until the next keyframe --
      // "no map yet" -- rather than a map with a hole in its history.
      this.map = null;
      this.mapDrops++;
      return `map cache passed ${this.maxMapBytes} bytes; dropped until the next keyframe`;
    }
    map.patches.push(unit);
    map.lastSeq = seq;
    map.bytes += size;
    return undefined;
  }

  /** The map as it stands: keyframe then patches, each header before its binary. */
  mapReplay(): Outgoing[] {
    if (!this.map) return [];
    const out: Outgoing[] = [];
    for (const unit of [this.map.keyframe, ...this.map.patches]) {
      out.push(unit.text);
      if (unit.binary) out.push(unit.binary);
    }
    return out;
  }

  /** Everything a new viewer needs, in the order the car itself would send it. */
  replay(): Outgoing[] {
    const out: Outgoing[] = [];
    if (this.hello) out.push(this.hello.text);
    out.push(...this.mapReplay());
    if (this.scan) {
      out.push(this.scan.text);
      if (this.scan.binary) out.push(this.scan.binary);
    }
    for (const type of STATE_TYPES) {
      const text = this.state.get(type);
      if (text !== undefined) out.push(text);
    }
    return out;
  }
}
