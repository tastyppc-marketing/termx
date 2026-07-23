import type { SplitDir, SplitNode } from "../state/layout";

/// All values are container fractions in [0, 1]; the renderer multiplies by
/// 100 into percentage-based absolute positioning.
export interface FractionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneRect {
  sessionId: number;
  box: FractionBox;
}

export interface DividerRect {
  /// Child-index path from the tab root to the split node this divider resizes.
  path: number[];
  dir: SplitDir;
  sizes: [number, number];
  /// The split node's own box — drag math projects the pointer onto this
  /// region's axis, not the whole container.
  box: FractionBox;
  /// Container fraction where the divider line sits on the split axis
  /// (x for "row", y for "col").
  position: number;
}

export interface SplitRects {
  panes: PaneRect[];
  dividers: DividerRect[];
}

export interface FractionOverride {
  path: number[];
  fraction: number;
}

export function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((step, index) => step === b[index]);
}

/// Flattens a layout_v1 split tree into absolutely-positioned pane and divider
/// boxes. Panes come back sorted by session id: the renderer keeps every pane
/// a keyed SIBLING in one container, and new sessions always get higher ids,
/// so splitting or closing a pane never moves (and never remounts) the DOM
/// node of a terminal that stays alive.
export function computeRects(
  root: SplitNode,
  override?: FractionOverride,
): SplitRects {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  walk(root, { left: 0, top: 0, width: 1, height: 1 }, [], override, panes, dividers);
  panes.sort((a, b) => a.sessionId - b.sessionId);
  return { panes, dividers };
}

function walk(
  node: SplitNode,
  box: FractionBox,
  path: number[],
  override: FractionOverride | undefined,
  panes: PaneRect[],
  dividers: DividerRect[],
): void {
  if (node.kind === "pane") {
    panes.push({ sessionId: node.sessionId, box });
    return;
  }
  const fraction =
    override !== undefined && samePath(override.path, path)
      ? override.fraction
      : node.sizes[0];
  if (node.dir === "row") {
    const firstWidth = box.width * fraction;
    dividers.push({
      path,
      dir: "row",
      sizes: node.sizes,
      box,
      position: box.left + firstWidth,
    });
    walk(node.children[0], { ...box, width: firstWidth }, [...path, 0], override, panes, dividers);
    walk(
      node.children[1],
      { ...box, left: box.left + firstWidth, width: box.width - firstWidth },
      [...path, 1],
      override,
      panes,
      dividers,
    );
  } else {
    const firstHeight = box.height * fraction;
    dividers.push({
      path,
      dir: "col",
      sizes: node.sizes,
      box,
      position: box.top + firstHeight,
    });
    walk(node.children[0], { ...box, height: firstHeight }, [...path, 0], override, panes, dividers);
    walk(
      node.children[1],
      { ...box, top: box.top + firstHeight, height: box.height - firstHeight },
      [...path, 1],
      override,
      panes,
      dividers,
    );
  }
}
