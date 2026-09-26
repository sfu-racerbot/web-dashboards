// Reassembling the car's messages into units the relay can forward whole.
//
// Every car message is one JSON text frame. A header that declares a
// numeric `bytes` field (today: map, map_patch, scan) is followed by exactly
// one binary frame of that length -- see the car repo's protocol.py and
// mapstream.py. The browser holds a single "what does the next binary
// mean" slot, so the relay must never split a header from its binary or
// let another message in between. Grouping them here is what guarantees
// that: the broadcast loop only ever sees whole units.
//
// Only JSON headers are parsed. Binary payloads are never inflated or
// decoded; the relay only checks their length against the header.

export interface Unit {
  /** The header's `type`, or "" if it had none. */
  type: string;
  /** The parsed header. */
  header: Record<string, unknown>;
  /** The header exactly as the car sent it, so it is forwarded byte-for-byte. */
  text: string;
  /** The binary frame that belongs to this header, if it declared one. */
  binary?: ArrayBuffer;
}

export interface PushResult {
  units: Unit[];
  /** Why something was dropped, for the log. Never includes payload data. */
  problem?: string;
}

export function expectsBinary(header: Record<string, unknown>): boolean {
  return typeof header.bytes === "number";
}

export class Framer {
  private pending: { header: Record<string, unknown>; text: string } | null = null;
  /** Units dropped because a header and its binary did not line up. */
  desyncs = 0;

  reset(): void {
    this.pending = null;
  }

  push(data: string | ArrayBuffer | ArrayBufferView): PushResult {
    if (typeof data === "string") return this.pushText(data);
    const buffer = data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return this.pushBinary(buffer);
  }

  private pushText(text: string): PushResult {
    let problem: string | undefined;
    if (this.pending) {
      // The header before this one never got its binary. Forwarding it now
      // would point every browser's binary slot at the wrong payload.
      problem = `${String(this.pending.header.type)} header was not followed by its binary; dropped`;
      this.pending = null;
      this.desyncs++;
    }
    let header: unknown;
    try {
      header = JSON.parse(text);
    } catch {
      return { units: [], problem: "a text frame that is not JSON; dropped" };
    }
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      return { units: [], problem: "a JSON frame that is not an object; dropped" };
    }
    const h = header as Record<string, unknown>;
    const type = typeof h.type === "string" ? h.type : "";
    if (expectsBinary(h)) {
      this.pending = { header: h, text };
      return { units: [], problem };
    }
    return { units: [{ type, header: h, text }], problem };
  }

  private pushBinary(binary: ArrayBuffer): PushResult {
    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      this.desyncs++;
      return { units: [], problem: `a ${binary.byteLength}-byte binary frame with no header before it; dropped` };
    }
    const declared = pending.header.bytes as number;
    if (binary.byteLength !== declared) {
      this.desyncs++;
      return {
        units: [],
        problem: `${String(pending.header.type)} binary is ${binary.byteLength} bytes, header says ${declared}; dropped`,
      };
    }
    const type = typeof pending.header.type === "string" ? pending.header.type : "";
    return { units: [{ type, header: pending.header, text: pending.text, binary }] };
  }
}
