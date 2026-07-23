import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "../frames";

const OUTPUT_FIXTURE = new Uint8Array([
  1,
  42, 0, 0, 0,
  64, 66, 15, 0, 0, 0, 0, 0,
  104, 105, 13, 10,
]);

const INPUT_FIXTURE = new Uint8Array([
  2,
  3, 0, 0, 0,
  100, 105, 114, 13,
]);

describe("M1 binary frames", () => {
  it("matches the Rust output fixture byte-for-byte", () => {
    const frame = {
      type: "output" as const,
      sessionId: 42,
      offset: 1_000_000n,
      data: new TextEncoder().encode("hi\r\n"),
    };

    expect(encodeFrame(frame)).toEqual(OUTPUT_FIXTURE);
    const decoded = decodeFrame(OUTPUT_FIXTURE);
    expect({ ...decoded, data: [...decoded.data] }).toEqual({
      ...frame,
      data: [...frame.data],
    });
  });

  it("matches the Rust input fixture byte-for-byte", () => {
    const frame = {
      type: "input" as const,
      sessionId: 3,
      data: new TextEncoder().encode("dir\r"),
    };

    expect(encodeFrame(frame)).toEqual(INPUT_FIXTURE);
    const decoded = decodeFrame(INPUT_FIXTURE);
    expect({ ...decoded, data: [...decoded.data] }).toEqual({
      ...frame,
      data: [...frame.data],
    });
  });

  it("preserves the full unsigned 64-bit output offset", () => {
    const offset = 0xfedcba9876543210n;
    const encoded = encodeFrame({
      type: "output",
      sessionId: 0xffffffff,
      offset,
      data: new Uint8Array([1]),
    });

    const decoded = decodeFrame(encoded);

    expect(decoded.type).toBe("output");
    if (decoded.type === "output") {
      expect(decoded.offset).toBe(offset);
    }
  });

  it.each([
    ["empty", new Uint8Array()],
    ["truncated output", new Uint8Array([1, 0, 0])],
    ["truncated input", new Uint8Array([2, 0, 0, 0])],
    ["unknown tag", new Uint8Array([9, 0, 0, 0, 0])],
  ])("rejects an %s frame", (_name, bytes) => {
    expect(() => decodeFrame(bytes)).toThrow();
  });

  it("decodes only the addressed bytes of a typed-array view", () => {
    const wrapped = new Uint8Array(OUTPUT_FIXTURE.length + 4);
    wrapped.set(OUTPUT_FIXTURE, 2);
    const view = wrapped.subarray(2, 2 + OUTPUT_FIXTURE.length);

    const decoded = decodeFrame(view);
    expect({ ...decoded, data: [...decoded.data] }).toEqual({
      type: "output",
      sessionId: 42,
      offset: 1_000_000n,
      data: [...new TextEncoder().encode("hi\r\n")],
    });
  });
});
