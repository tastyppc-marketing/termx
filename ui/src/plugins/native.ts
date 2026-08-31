import { invoke } from "@tauri-apps/api/core";

export interface PluginNative {
  readRuntime(path: string): Promise<string | null>;
  probe(url: string, timeoutMs: number): Promise<string>;
  spawn(command: string, args: string[], cwd: string): Promise<number>;
  stderrTail(pid: number): Promise<string>;
}

export const tauriPluginNative: PluginNative = {
  readRuntime(path) {
    return invoke<string | null>("plugin_read_runtime", { path });
  },
  probe(url, timeoutMs) {
    return invoke<string>("plugin_probe", { url, timeoutMs });
  },
  spawn(command, args, cwd) {
    return invoke<number>("plugin_spawn", { command, args, cwd });
  },
  stderrTail(pid) {
    return invoke<string>("plugin_stderr_tail", { pid });
  },
};
