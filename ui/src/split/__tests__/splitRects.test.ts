import { describe, expect, it } from "vitest";
import type { SplitNode } from "../../state/layout";
import {
  computeRects,
  pathToSplitNode,
  samePath,
  type FractionBox,
  type SplitBranch,
} from "../splitRects";

function pane(sessionId: number): SplitNode {
  return { kind: "pane", sessionId };
}

const FULL: FractionBox = { left: 0, top: 0, width: 1, height: 1 };

describe("computeRects", () => {
  it("gives a lone pane the whole container and no dividers", () => {
    const rects = computeRects(pane(1));
    expect(rects.panes).toEqual([{ sessionId: 1, box: FULL }]);
    expect(rects.dividers).toEqual([]);
  });

  it("splits a row into side-by-side boxes with a divider on the seam", () => {
    const rects = computeRects({
      kind: "split",
      dir: "row",
      sizes: [0.25, 0.75],
      children: [pane(1), pane(2)],
    });
    expect(rects.panes).toEqual([
      { sessionId: 1, box: { left: 0, top: 0, width: 0.25, height: 1 } },
      { sessionId: 2, box: { left: 0.25, top: 0, width: 0.75, height: 1 } },
    ]);
    expect(rects.dividers).toHaveLength(1);
    expect(rects.dividers[0]).toMatchObject({
      path: [],
      dir: "row",
      position: 0.25,
      box: FULL,
    });
  });

  it("computes nested boxes and divider positions in container coordinates", () => {
    // Row 50/50; right side stacked 50/50 vertically.
    const rects = computeRects({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        pane(1),
        {
          kind: "split",
          dir: "col",
          sizes: [0.5, 0.5],
          children: [pane(2), pane(3)],
        },
      ],
    });
    expect(rects.panes).toEqual([
      { sessionId: 1, box: { left: 0, top: 0, width: 0.5, height: 1 } },
      { sessionId: 2, box: { left: 0.5, top: 0, width: 0.5, height: 0.5 } },
      { sessionId: 3, box: { left: 0.5, top: 0.5, width: 0.5, height: 0.5 } },
    ]);
    const nested = rects.dividers.find((divider) => divider.path.length === 1);
    expect(nested).toMatchObject({
      path: [1],
      dir: "col",
      position: 0.5,
      box: { left: 0.5, top: 0, width: 0.5, height: 1 },
    });
  });

  it("sorts panes by session id regardless of tree position", () => {
    const rects = computeRects({
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane(9), pane(2)],
    });
    expect(rects.panes.map((rect) => rect.sessionId)).toEqual([2, 9]);
  });

  it("applies a drag override only to the addressed split node", () => {
    const inner: SplitBranch = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane(2), pane(3)],
    };
    const tree: SplitNode = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane(1), inner],
    };
    const rects = computeRects(tree, { node: inner, fraction: 0.2 });
    const outerDivider = rects.dividers.find((divider) => divider.path.length === 0);
    const innerDivider = rects.dividers.find((divider) => divider.path.length === 1);
    expect(outerDivider?.position).toBeCloseTo(0.5);
    expect(innerDivider?.position).toBeCloseTo(0.5 + 0.5 * 0.2);
    expect(rects.panes.find((rect) => rect.sessionId === 2)?.box.width).toBeCloseTo(0.1);
    expect(rects.panes.find((rect) => rect.sessionId === 3)?.box.width).toBeCloseTo(0.4);
    expect(innerDivider?.node).toBe(inner);
  });

  it("still applies the override when the node moved to a different path", () => {
    const inner: SplitBranch = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane(2), pane(3)],
    };
    // The same node, collapsed to the root after its sibling closed.
    const rects = computeRects(inner, { node: inner, fraction: 0.3 });
    expect(rects.dividers[0]?.position).toBeCloseTo(0.3);
  });
});

describe("pathToSplitNode", () => {
  const inner: SplitBranch = {
    kind: "split",
    dir: "col",
    sizes: [0.5, 0.5],
    children: [pane(2), pane(3)],
  };
  const tree: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [pane(1), inner],
  };

  it("finds a split node's current path by reference", () => {
    expect(pathToSplitNode(tree, tree as SplitBranch)).toEqual([]);
    expect(pathToSplitNode(tree, inner)).toEqual([1]);
  });

  it("returns null for a node no longer in the tree", () => {
    const gone: SplitBranch = {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane(8), pane(9)],
    };
    expect(pathToSplitNode(tree, gone)).toBeNull();
    expect(pathToSplitNode(pane(1), gone)).toBeNull();
  });
});

describe("samePath", () => {
  it("compares child-index paths element-wise", () => {
    expect(samePath([], [])).toBe(true);
    expect(samePath([0, 1], [0, 1])).toBe(true);
    expect(samePath([0, 1], [0])).toBe(false);
    expect(samePath([0, 1], [1, 1])).toBe(false);
  });
});
