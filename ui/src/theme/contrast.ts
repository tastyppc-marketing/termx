/**
 * WCAG 2.x relative-luminance math and the contrast auto-correct gate.
 *
 * Every derived token that carries meaning (text, accent, semantics, tab
 * stripes) is run through `ensureContrast`, so no theme — including a future
 * user-authored one — can produce unreadable UI. Written from the published
 * WCAG formulae; nothing here is ported from any other implementation.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Parse `#rgb` / `#rrggbb`. Throws on anything else: theme colours are
 * compile-time constants, so a malformed one is a build-time test failure —
 * never a silent runtime fallback that hides the mistake.
 */
export function parseHex(hex: string): Rgb {
  const value = hex.trim();
  if (!HEX_PATTERN.test(value)) {
    throw new Error(`Unparseable colour: ${hex}`);
  }
  const digits = value.slice(1);
  const expand = digits.length === 3
    ? digits.split("").map((digit) => digit + digit)
    : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
  return {
    r: Number.parseInt(expand[0]!, 16),
    g: Number.parseInt(expand[1]!, 16),
    b: Number.parseInt(expand[2]!, 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** `color` laid over `background` at `alpha` (0-1), flattened to an opaque hex. */
export function blend(color: string, background: string, alpha: number): string {
  const front = parseHex(color);
  const back = parseHex(background);
  const mix = (a: number, b: number) => b + (a - b) * alpha;
  return toHex({
    r: mix(front.r, back.r),
    g: mix(front.g, back.g),
    b: mix(front.b, back.b),
  });
}

function channelLuminance(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Binary-search steps: 2^-20 of the blend range is well below one 8-bit step. */
const SEARCH_STEPS = 20;

/**
 * `color` if it already clears `ratio` against `background`, otherwise the
 * least amount of pure white (dark themes) or pure black (light themes) mixed
 * in that does clear it. When even the pure extreme cannot reach the target,
 * the extreme is returned — the most legible colour available.
 */
export function ensureContrast(
  color: string,
  background: string,
  ratio: number,
  mode: "dark" | "light",
): string {
  if (contrastRatio(color, background) >= ratio) {
    return color;
  }
  const extreme = mode === "dark" ? "#ffffff" : "#000000";
  if (contrastRatio(extreme, background) < ratio) {
    return extreme;
  }
  let low = 0;
  let high = 1;
  for (let step = 0; step < SEARCH_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (contrastRatio(blend(extreme, color, middle), background) >= ratio) {
      high = middle;
    } else {
      low = middle;
    }
  }
  // The search runs on continuous blends; the answer is quantised to 8 bits,
  // which can land a hair under the target. Walk up whole steps until it holds.
  for (let t = high; t <= 1; t += 1 / 255) {
    const candidate = blend(extreme, color, t);
    if (contrastRatio(candidate, background) >= ratio) {
      return candidate;
    }
  }
  return extreme;
}
