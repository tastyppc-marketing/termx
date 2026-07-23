import type { MenuPoint } from "./ContextMenu";

export const POINTER_DRAG_THRESHOLD_PX = 4;

export type DragSource =
  | { kind: "tab"; tabId: string; groupId: string | null; index: number }
  | { kind: "group"; groupId: string; index: number };

export type DropTarget =
  | { kind: "tab"; groupId: string | null; index: number }
  | { kind: "group"; index: number };

export type SidebarDropCommand =
  | { kind: "move_tab"; tabId: string; groupId: string | null; index: number }
  | { kind: "reorder_group"; groupId: string; index: number };

export function crossedDragThreshold(origin: MenuPoint, current: MenuPoint): boolean {
  const deltaX = current.x - origin.x;
  const deltaY = current.y - origin.y;
  return deltaX * deltaX + deltaY * deltaY >= POINTER_DRAG_THRESHOLD_PX ** 2;
}

export function commitDrop(
  source: DragSource,
  target: DropTarget,
): SidebarDropCommand | null {
  if (source.kind !== target.kind) {
    return null;
  }

  const requestedIndex = Number.isFinite(target.index)
    ? Math.max(0, Math.trunc(target.index))
    : 0;
  if (source.kind === "tab" && target.kind === "tab") {
    const sameContainer = source.groupId === target.groupId;
    const index = sameContainer && requestedIndex > source.index
      ? requestedIndex - 1
      : requestedIndex;
    if (sameContainer && index === source.index) {
      return null;
    }
    return {
      kind: "move_tab",
      tabId: source.tabId,
      groupId: target.groupId,
      index,
    };
  }

  if (source.kind === "group" && target.kind === "group") {
    const index = requestedIndex > source.index ? requestedIndex - 1 : requestedIndex;
    if (index === source.index) {
      return null;
    }
    return { kind: "reorder_group", groupId: source.groupId, index };
  }
  return null;
}
