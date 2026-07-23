import { MIN_PANE_FRACTION } from "../state/layout";

/// Fraction of the first sibling given a pointer position on the split axis,
/// clamped so both sides keep the layout_v1 minimum. Pure — the divider
/// component feeds it pointer coordinates and rect bounds.
export function dividerFraction(
  pointerPx: number,
  rectStartPx: number,
  rectSizePx: number,
): number {
  if (!Number.isFinite(pointerPx) || !Number.isFinite(rectStartPx) || rectSizePx <= 0) {
    return 0.5;
  }
  const raw = (pointerPx - rectStartPx) / rectSizePx;
  return Math.min(Math.max(raw, MIN_PANE_FRACTION), 1 - MIN_PANE_FRACTION);
}

/// Sizes tuple for store.resizePane from a first-side fraction.
export function sizesFromFraction(first: number): [number, number] {
  const clamped = Math.min(
    Math.max(first, MIN_PANE_FRACTION),
    1 - MIN_PANE_FRACTION,
  );
  return [clamped, 1 - clamped];
}
