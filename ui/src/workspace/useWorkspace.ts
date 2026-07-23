import { useSyncExternalStore } from "react";
import type {
  WorkspaceController,
  WorkspaceSnapshot,
} from "./WorkspaceController";

export function useWorkspace(controller: WorkspaceController): WorkspaceSnapshot {
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}
