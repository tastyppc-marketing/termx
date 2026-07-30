/**
 * Directory completion via the `list_dirs` Tauri command (folder searcher
 * backend). The command never errors by contract; this wrapper is equally
 * tolerant so palette typing can never surface an exception.
 */

import { invoke } from "@tauri-apps/api/core";

export type ListDirs = (prefix: string) => Promise<readonly string[]>;

export const tauriListDirs: ListDirs = async (prefix) => {
  try {
    const value = await invoke<unknown>("list_dirs", { prefix });
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};
