import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast } from "../contrast";

describe("contrastRatio", () => {
  it("pins the WCAG extremes", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 2);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
  });

  it("pins a known mid pair (#777777 on white ≈ 4.48)", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("accepts 3-digit hex", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 2);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#7aa2f7", "#0f1115")).toBeCloseTo(
      contrastRatio("#0f1115", "#7aa2f7"),
      6,
    );
  });

  it("rejects an unparseable color", () => {
    expect(() => contrastRatio("not-a-color", "#000000")).toThrow();
  });
});

describe("ensureContrast", () => {
  it("returns the input unchanged when the pair already passes", () => {
    expect(ensureContrast("#ffffff", "#000000", 4.5, "dark")).toBe("#ffffff");
    expect(ensureContrast("#24262b", "#f4f2ee", 4.5, "light")).toBe("#24262b");
  });

  it("lifts a failing dark-mode pair toward white until it passes", () => {
    const fixed = ensureContrast("#2a2f38", "#0f1115", 4.5, "dark");
    expect(fixed).not.toBe("#2a2f38");
    expect(contrastRatio(fixed, "#0f1115")).toBeGreaterThanOrEqual(4.5);
  });

  it("pushes a failing light-mode pair toward black until it passes", () => {
    const fixed = ensureContrast("#d8d4cf", "#f4f2ee", 4.5, "light");
    expect(contrastRatio(fixed, "#f4f2ee")).toBeGreaterThanOrEqual(4.5);
  });

  it("stops at the minimum blend it needs (never jumps to pure white)", () => {
    const fixed = ensureContrast("#2a2f38", "#0f1115", 3, "dark");
    expect(fixed).not.toBe("#ffffff");
    expect(contrastRatio(fixed, "#0f1115")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(fixed, "#0f1115")).toBeLessThan(6);
  });

  it("converges for a pathological pair (color ≈ background)", () => {
    const fixed = ensureContrast("#0f1116", "#0f1115", 4.5, "dark");
    expect(contrastRatio(fixed, "#0f1115")).toBeGreaterThanOrEqual(4.5);
  });

  it("returns the best available color when the target is unreachable", () => {
    // Nothing reaches 21:1 against mid grey; the search must still terminate
    // with the most contrasting colour it can produce.
    const fixed = ensureContrast("#808080", "#808080", 21, "dark");
    expect(fixed).toBe("#ffffff");
  });
});
