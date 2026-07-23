import { describe, expect, it } from "vitest";
import {
  POINTER_DRAG_THRESHOLD_PX,
  commitDrop,
  crossedDragThreshold,
  type DragSource,
  type DropTarget,
} from "../pointerDrag";

describe("crossedDragThreshold", () => {
  it("uses a four-pixel Euclidean threshold inclusively", () => {
    expect(crossedDragThreshold({ x: 0, y: 0 }, { x: 3.99, y: 0 })).toBe(false);
    expect(crossedDragThreshold(
      { x: 10, y: 10 },
      { x: 10 + POINTER_DRAG_THRESHOLD_PX, y: 10 },
    )).toBe(true);
    expect(crossedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(true);
  });
});

describe("commitDrop", () => {
  const tab: DragSource = { kind: "tab", tabId: "tab", groupId: "a", index: 1 };

  it("converts same-container positions to post-removal indices", () => {
    expect(commitDrop(tab, { kind: "tab", groupId: "a", index: 4 })).toEqual({
      kind: "move_tab",
      tabId: "tab",
      groupId: "a",
      index: 3,
    });
    expect(commitDrop(tab, { kind: "tab", groupId: "a", index: 0 })).toEqual({
      kind: "move_tab",
      tabId: "tab",
      groupId: "a",
      index: 0,
    });
  });

  it("returns null for before/after slots that leave a tab unchanged", () => {
    expect(commitDrop(tab, { kind: "tab", groupId: "a", index: 1 })).toBeNull();
    expect(commitDrop(tab, { kind: "tab", groupId: "a", index: 2 })).toBeNull();
  });

  it("moves tabs across groups and the ungrouped root without index adjustment", () => {
    expect(commitDrop(tab, { kind: "tab", groupId: "b", index: 2 })).toEqual({
      kind: "move_tab",
      tabId: "tab",
      groupId: "b",
      index: 2,
    });
    expect(commitDrop(tab, { kind: "tab", groupId: null, index: 0 })).toEqual({
      kind: "move_tab",
      tabId: "tab",
      groupId: null,
      index: 0,
    });
  });

  it("reorders groups with post-removal indices and rejects no-op slots", () => {
    const group: DragSource = { kind: "group", groupId: "group", index: 0 };
    expect(commitDrop(group, { kind: "group", index: 3 })).toEqual({
      kind: "reorder_group",
      groupId: "group",
      index: 2,
    });
    expect(commitDrop(group, { kind: "group", index: 1 })).toBeNull();
  });

  it("rejects mismatched source and target kinds", () => {
    const groupTarget: DropTarget = { kind: "group", index: 0 };
    const tabTarget: DropTarget = { kind: "tab", groupId: null, index: 0 };
    expect(commitDrop(tab, groupTarget)).toBeNull();
    expect(commitDrop({ kind: "group", groupId: "g", index: 0 }, tabTarget)).toBeNull();
  });

  it("clamps negative, fractional, and non-finite edge positions", () => {
    expect(commitDrop(tab, { kind: "tab", groupId: "b", index: -100 })).toMatchObject({ index: 0 });
    expect(commitDrop(tab, { kind: "tab", groupId: "b", index: 2.9 })).toMatchObject({ index: 2 });
    expect(commitDrop(tab, { kind: "tab", groupId: "b", index: Number.POSITIVE_INFINITY }))
      .toMatchObject({ index: 0 });
  });
});
