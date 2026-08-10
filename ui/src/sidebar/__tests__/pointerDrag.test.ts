import { describe, expect, it } from "vitest";
import {
  POINTER_DRAG_THRESHOLD_PX,
  commitDrop,
  crossedDragThreshold,
  type DragSource,
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
  const tab: DragSource = {
    item: { kind: "tab", id: "tab" },
    containerId: "a",
    index: 1,
  };

  it("converts same-container positions to post-removal indices", () => {
    expect(commitDrop(tab, { containerId: "a", index: 4 })).toEqual({
      kind: "move_item",
      item: { kind: "tab", id: "tab" },
      groupId: "a",
      index: 3,
    });
    expect(commitDrop(tab, { containerId: "a", index: 0 })).toEqual({
      kind: "move_item",
      item: { kind: "tab", id: "tab" },
      groupId: "a",
      index: 0,
    });
  });

  it("returns null for before/after slots that leave an item unchanged", () => {
    expect(commitDrop(tab, { containerId: "a", index: 1 })).toBeNull();
    expect(commitDrop(tab, { containerId: "a", index: 2 })).toBeNull();
  });

  it("moves items across containers without index adjustment", () => {
    expect(commitDrop(tab, { containerId: "b", index: 2 })).toEqual({
      kind: "move_item",
      item: { kind: "tab", id: "tab" },
      groupId: "b",
      index: 2,
    });
    expect(commitDrop(tab, { containerId: null, index: 0 })).toEqual({
      kind: "move_item",
      item: { kind: "tab", id: "tab" },
      groupId: null,
      index: 0,
    });
  });

  it("carries groups through the same container arithmetic", () => {
    const group: DragSource = {
      item: { kind: "group", id: "group" },
      containerId: null,
      index: 0,
    };
    expect(commitDrop(group, { containerId: null, index: 3 })).toEqual({
      kind: "move_item",
      item: { kind: "group", id: "group" },
      groupId: null,
      index: 2,
    });
    expect(commitDrop(group, { containerId: null, index: 1 })).toBeNull();
    expect(commitDrop(group, { containerId: "nest", index: 0 })).toEqual({
      kind: "move_item",
      item: { kind: "group", id: "group" },
      groupId: "nest",
      index: 0,
    });
  });

  it("clamps negative, fractional, and non-finite edge positions", () => {
    expect(commitDrop(tab, { containerId: "b", index: -100 })).toMatchObject({ index: 0 });
    expect(commitDrop(tab, { containerId: "b", index: 2.9 })).toMatchObject({ index: 2 });
    expect(commitDrop(tab, { containerId: "b", index: Number.POSITIVE_INFINITY }))
      .toMatchObject({ index: 0 });
  });
});
