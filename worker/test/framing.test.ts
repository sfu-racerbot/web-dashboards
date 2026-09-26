import { describe, expect, it } from "vitest";
import { Framer } from "../src/framing";

const bin = (n: number) => new Uint8Array(n).fill(7).buffer;

describe("Framer", () => {
  it("passes a JSON-only message through as one unit, byte-for-byte", () => {
    const f = new Framer();
    const text = '{"type":"batch","items":[{"type":"pose","x":1,"y":2,"yaw":0}]}';
    const { units, problem } = f.push(text);
    expect(problem).toBeUndefined();
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe("batch");
    expect(units[0].text).toBe(text);
    expect(units[0].binary).toBeUndefined();
  });

  it("holds a header that declares bytes until its binary arrives, then keeps them together", () => {
    const f = new Framer();
    expect(f.push('{"type":"scan","bytes":4,"count":2}').units).toEqual([]);
    const { units } = f.push(bin(4));
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe("scan");
    expect(units[0].binary?.byteLength).toBe(4);
  });

  it("accepts typed-array views as binary frames", () => {
    const f = new Framer();
    f.push('{"type":"map_patch","seq":2,"bytes":3}');
    const view = new Uint8Array(new Uint8Array([9, 9, 1, 2, 3, 9]).buffer, 2, 3);
    const unit = f.push(view).units[0];
    expect(new Uint8Array(unit.binary!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("drops a pair whose binary is the wrong length, and says why", () => {
    const f = new Framer();
    f.push('{"type":"map","bytes":10}');
    const { units, problem } = f.push(bin(9));
    expect(units).toEqual([]);
    expect(problem).toMatch(/map binary is 9 bytes, header says 10/);
    expect(f.desyncs).toBe(1);
  });

  it("drops a header whose binary never came, and still delivers what came next", () => {
    const f = new Framer();
    f.push('{"type":"scan","bytes":4}');
    const { units, problem } = f.push('{"type":"stats","cpu_percent":1}');
    expect(problem).toMatch(/scan header was not followed by its binary/);
    expect(units.map((u) => u.type)).toEqual(["stats"]);
    // ...and the binary that eventually turns up is not glued to anything.
    expect(f.push(bin(4)).units).toEqual([]);
    expect(f.desyncs).toBe(2);
  });

  it("drops a binary with no header before it", () => {
    const f = new Framer();
    const { units, problem } = f.push(bin(3));
    expect(units).toEqual([]);
    expect(problem).toMatch(/no header before it/);
  });

  it("drops text that is not a JSON object", () => {
    const f = new Framer();
    expect(f.push("not json").problem).toMatch(/not JSON/);
    expect(f.push("[1,2]").problem).toMatch(/not an object/);
  });

  it("forgets a pending header on reset (a new car connection)", () => {
    const f = new Framer();
    f.push('{"type":"scan","bytes":4}');
    f.reset();
    expect(f.push(bin(4)).problem).toMatch(/no header/);
  });
});
