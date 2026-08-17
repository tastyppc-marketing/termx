/**
 * SSH-side Tauri commands (ssh-sessions spec §1, §6).
 *
 * `read_ssh_config` is tolerant like the rest of the read wrappers: a failure
 * is an empty host inventory, never an exception into bootstrap.
 */

import { invoke } from "@tauri-apps/api/core";

/** The raw text of `~/.ssh/config`, or null when there is none to read. */
export async function tauriReadSshConfig(): Promise<string | null> {
  try {
    const value = await invoke<unknown>("read_ssh_config");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
