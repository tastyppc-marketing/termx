import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { tauriPluginNative } from "../native";

/**
 * The Rust side (src-tauri/src/plugins.rs) names these commands and argument
 * keys; Tauri maps camelCase argument keys onto snake_case parameters, so a
 * `timeout_ms`-for-`timeoutMs` slip or a mistyped command name fails only at
 * runtime, in a code path that already only runs when a plugin is unhealthy.
 * These pins are the compile-time-adjacent check that shape never drifts.
 */
describe("tauriPluginNative invoke wrappers", () => {
  beforeEach(() => invoke.mockReset());

  it("reads a runtime file by absolute path", async () => {
    invoke.mockResolvedValue('{"port":7345}');

    await expect(
      tauriPluginNative.readRuntime("C:\\plugins\\showroom\\runtime.json"),
    ).resolves.toBe('{"port":7345}');
    expect(invoke).toHaveBeenCalledWith("plugin_read_runtime", {
      path: "C:\\plugins\\showroom\\runtime.json",
    });
  });

  it("passes a missing runtime file through as null", async () => {
    invoke.mockResolvedValue(null);

    await expect(
      tauriPluginNative.readRuntime("C:\\plugins\\showroom\\runtime.json"),
    ).resolves.toBeNull();
  });

  it("probes with the camelCase timeout key", async () => {
    invoke.mockResolvedValue('{"ok":true,"version":"1.2.3"}');

    await expect(
      tauriPluginNative.probe("http://127.0.0.1:7345/api/health", 1_500),
    ).resolves.toBe('{"ok":true,"version":"1.2.3"}');
    expect(invoke).toHaveBeenCalledWith("plugin_probe", {
      url: "http://127.0.0.1:7345/api/health",
      timeoutMs: 1_500,
    });
  });

  it("spawns with command, args and cwd unchanged", async () => {
    invoke.mockResolvedValue(4242);

    await expect(
      tauriPluginNative.spawn(
        "node",
        ["server/showroom.js"],
        "C:\\plugins\\showroom",
      ),
    ).resolves.toBe(4242);
    expect(invoke).toHaveBeenCalledWith("plugin_spawn", {
      command: "node",
      args: ["server/showroom.js"],
      cwd: "C:\\plugins\\showroom",
      env: undefined,
    });
  });

  it("passes the env map through under the env key", async () => {
    invoke.mockResolvedValue(4242);

    await tauriPluginNative.spawn(
      "node",
      ["server/showroom.js"],
      "C:\\plugins\\showroom",
      { TERMX: "1", TERMX_PLUGIN_ID: "showroom" },
    );
    expect(invoke).toHaveBeenCalledWith("plugin_spawn", {
      command: "node",
      args: ["server/showroom.js"],
      cwd: "C:\\plugins\\showroom",
      env: { TERMX: "1", TERMX_PLUGIN_ID: "showroom" },
    });
  });

  it("reads a stderr tail by pid", async () => {
    invoke.mockResolvedValue("EADDRINUSE\n");

    await expect(tauriPluginNative.stderrTail(4242)).resolves.toBe(
      "EADDRINUSE\n",
    );
    expect(invoke).toHaveBeenCalledWith("plugin_stderr_tail", { pid: 4242 });
  });

  it("reads a folder's manifest under the folder key", async () => {
    // The Rust side joins `termx-plugin.json` itself, so Settings passes the
    // FOLDER the user picked — sending a file path would read
    // `<…>\termx-plugin.json\termx-plugin.json` and always report "missing".
    invoke.mockResolvedValue('{"manifest":1}');

    await expect(
      tauriPluginNative.readManifest("C:\\plugins\\showroom"),
    ).resolves.toBe('{"manifest":1}');
    expect(invoke).toHaveBeenCalledWith("plugin_read_manifest", {
      folder: "C:\\plugins\\showroom",
    });
  });

  it("passes a folder without a manifest through as null", async () => {
    invoke.mockResolvedValue(null);

    await expect(
      tauriPluginNative.readManifest("C:\\plugins\\showroom"),
    ).resolves.toBeNull();
  });

  it("uses exactly these five command names", async () => {
    invoke.mockResolvedValue("");

    await tauriPluginNative.readRuntime("C:\\r.json");
    await tauriPluginNative.probe("http://127.0.0.1:1/", 200);
    await tauriPluginNative.spawn("node", [], "C:\\p");
    await tauriPluginNative.stderrTail(1);
    await tauriPluginNative.readManifest("C:\\p");

    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "plugin_read_runtime",
      "plugin_probe",
      "plugin_spawn",
      "plugin_stderr_tail",
      "plugin_read_manifest",
    ]);
  });
});
