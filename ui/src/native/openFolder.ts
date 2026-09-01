/**
 * `open_folder` — show a folder in the OS file manager.
 *
 * Not to be confused with `openFolderHere` in ./folderSession, which picks a
 * folder and starts a shell in it. This one opens no session and changes
 * nothing: it hands an existing directory to Explorer.
 *
 * The command never errors by contract and returns whether a window was asked
 * for; the wrapper is equally tolerant, so running outside Tauri (a browser
 * dev server, a test) is a quiet `false` rather than an exception inside a
 * click handler.
 */

import { invoke } from "@tauri-apps/api/core";

export type OpenFolder = (path: string) => Promise<boolean>;

export const tauriOpenFolder: OpenFolder = async (path) => {
  try {
    return (await invoke<unknown>("open_folder", { path })) === true;
  } catch {
    return false;
  }
};
