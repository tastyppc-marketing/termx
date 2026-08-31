import { invoke } from "@tauri-apps/api/core";

export interface PluginNative {
  readRuntime(path: string): Promise<string | null>;
  probe(url: string, timeoutMs: number): Promise<string>;
  /**
   * `env` entries are ADDED to the inherited environment. Spec §2 requires
   * TERMX=1 and TERMX_PLUGIN_ID=<manifest id> so a plugin process can tell it
   * was started by TermX; the caller (lifecycle.ts) stamps those values.
   */
  spawn(
    command: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<number>;
  stderrTail(pid: number): Promise<string>;
}

export const tauriPluginNative: PluginNative = {
  readRuntime(path) {
    return invoke<string | null>("plugin_read_runtime", { path });
  },
  probe(url, timeoutMs) {
    return invoke<string>("plugin_probe", { url, timeoutMs });
  },
  spawn(command, args, cwd, env) {
    return invoke<number>("plugin_spawn", { command, args, cwd, env });
  },
  stderrTail(pid) {
    return invoke<string>("plugin_stderr_tail", { pid });
  },
};
