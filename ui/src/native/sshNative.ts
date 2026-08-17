/**
 * SSH-side Tauri commands (ssh-sessions spec §1, §6).
 *
 * `read_ssh_config` is tolerant like the rest of the read wrappers: a failure
 * is an empty host inventory, never an exception into bootstrap. The secret
 * wrappers are deliberately NOT tolerant: a swallowed protect failure would
 * store a password the user believes is encrypted, and a swallowed unprotect
 * failure is indistinguishable from an empty password. Both throw, and the
 * credentials store decides what that means.
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

/** DPAPI-encrypt a secret for storage. Throws if the OS refuses. */
export async function tauriProtectSecret(plain: string): Promise<string> {
  return await invoke<string>("protect_secret", { plain });
}

/** Reverse of `tauriProtectSecret`. Throws for a blob this user cannot read. */
export async function tauriUnprotectSecret(data: string): Promise<string> {
  return await invoke<string>("unprotect_secret", { data });
}
