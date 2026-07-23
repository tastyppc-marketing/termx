import { describe, expect, it } from "vitest";
import { dividerFraction, sizesFromFraction } from "../splitMath";

describe("dividerFraction", () => {
  it("maps the pointer position to a fraction of the rect", () => {
    expect(dividerFraction(250, 100, 400)).toBeCloseTo(0.375);
    expect(dividerFraction(300, 100, 400)).toBeCloseTo(0.5);
  });

  it("clamps both ends to the layout_v1 minimum pane fraction", () => {
    expect(dividerFraction(0, 100, 400)).toBeCloseTo(0.1);
    expect(dividerFraction(5_000, 100, 400)).toBeCloseTo(0.9);
  });

  it("returns the midpoint on degenerate geometry", () => {
    expect(dividerFraction(50, 0, 0)).toBe(0.5);
    expect(dividerFraction(50, 0, -10)).toBe(0.5);
    expect(dividerFraction(Number.NaN, 0, 100)).toBe(0.5);
    expect(dividerFraction(50, Number.POSITIVE_INFINITY, 100)).toBe(0.5);
  });
});

describe("sizesFromFraction", () => {
  it("produces a complementary clamped pair", () => {
    expect(sizesFromFraction(0.3)).toEqual([0.3, 0.7]);
    const [first, second] = sizesFromFraction(0.02);
    expect(first).toBeCloseTo(0.1);
    expect(second).toBeCloseTo(0.9);
    const [bigFirst, smallSecond] = sizesFromFraction(0.99);
    expect(bigFirst).toBeCloseTo(0.9);
    expect(smallSecond).toBeCloseTo(0.1);
  });
});
