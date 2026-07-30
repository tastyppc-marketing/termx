/**
 * App data files (settings, ui state) via the Tauri storage commands.
 * The host process resolves the data dir (`%APPDATA%\TermX` or the portable
 * `data\` folder); the renderer only ever names one of the allowlisted files.
 */

import { invoke } from "@tauri-apps/api/core";

export type AppFileName = "settings_v1.json" | "ui_state_v1.json";

export interface AppFileStore {
  /** Returns file contents, or null when the file doesn't exist yet. */
  read(name: AppFileName): Promise<string | null>;
  write(name: AppFileName, contents: string): Promise<void>;
}

export const tauriAppFiles: AppFileStore = {
  async read(name) {
    const value = await invoke<unknown>("read_app_file", { name });
    return typeof value === "string" ? value : null;
  },
  async write(name, contents) {
    await invoke("write_app_file", { name, contents });
  },
};
