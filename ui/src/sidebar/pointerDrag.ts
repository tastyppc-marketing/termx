import type { Item } from "../state/layout";
import type { MenuPoint } from "./ContextMenu";

export const POINTER_DRAG_THRESHOLD_PX = 4;

/// Tabs and groups drag identically under layout_v2: an item, the container it
/// currently sits in (null = the root), and its index among that container's
/// items.
export interface DragSource {
  item: Item;
  containerId: string | null;
  index: number;
}

/// A slot: the container to drop into and the position within its items.
/// Nesting onto a group header is just that group with its items length.
export interface DropTarget {
  containerId: string | null;
  index: number;
}

export type SidebarDropCommand = {
  kind: "move_item";
  item: Item;
  groupId: string | null;
  index: number;
};

export function crossedDragThreshold(origin: MenuPoint, current: MenuPoint): boolean {
  const deltaX = current.x - origin.x;
  const deltaY = current.y - origin.y;
  return deltaX * deltaX + deltaY * deltaY >= POINTER_DRAG_THRESHOLD_PX ** 2;
}

export function commitDrop(
  source: DragSource,
  target: DropTarget,
): SidebarDropCommand | null {
  const requestedIndex = Number.isFinite(target.index)
    ? Math.max(0, Math.trunc(target.index))
    : 0;
  const sameContainer = source.containerId === target.containerId;
  const index = sameContainer && requestedIndex > source.index
    ? requestedIndex - 1
    : requestedIndex;
  if (sameContainer && index === source.index) {
    return null;
  }
  return {
    kind: "move_item",
    item: source.item,
    groupId: target.containerId,
    index,
  };
}
