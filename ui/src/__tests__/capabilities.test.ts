import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The capability file, found from the vitest root (the `ui` package). */
function capabilityPath(): string {
  const fromRoot = resolve(process.cwd(), "src-tauri/capabilities/default.json");
  return existsSync(fromRoot)
    ? fromRoot
    : resolve(process.cwd(), "ui/src-tauri/capabilities/default.json");
}

/**
 * Tauri 2 denies any command the window's capability file does not name, and
 * the frontend's call sites swallow the rejection so a missing permission is
 * silent — the feature simply never happens. These assertions are the only
 * thing standing between a trimmed permission list and a dead feature.
 */
const capability = JSON.parse(readFileSync(capabilityPath(), "utf8")) as {
  permissions: string[];
  windows: string[];
};

describe("main window capability", () => {
  it("applies to the main window", () => {
    expect(capability.windows).toContain("main");
  });

  it(
    "grants request-user-attention — core:default covers only getters, so " +
      "without this the taskbar never flashes when an agent finishes",
    () => {
      expect(capability.permissions).toContain("core:window:allow-request-user-attention");
    },
  );

  it("still grants the window lifecycle permissions the close path needs", () => {
    expect(capability.permissions).toContain("core:window:allow-close");
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });
});

describe("multi-window capability (Phase 1)", () => {
  it(
    "covers aux windows — a capability names the windows it applies to, so " +
      "without the aux-* glob a torn-out window has NO permissions at all " +
      "(no daemon bootstrap, no IPC — a dead shell)",
    () => {
      expect(capability.windows).toContain("aux-*");
    },
  );

  it(
    "grants create-webview-window — 'Move to new window' spawns a " +
      "WebviewWindow from JS, and without this grant the create call is " +
      "rejected at IPC and swallowed by openAuxWindows' per-slot catch: the " +
      "slot fills but no window ever appears",
    () => {
      expect(capability.permissions).toContain(
        "core:webview:allow-create-webview-window",
      );
    },
  );
});

describe("plugin native commands (Phase 1)", () => {
  it("grants the plugin lifecycle commands to every capable window", () => {
    expect(capability.permissions).toContain("allow-plugin-spawn");
    expect(capability.permissions).toContain("allow-plugin-read-runtime");
    expect(capability.permissions).toContain("allow-plugin-probe");
    expect(capability.permissions).toContain("allow-plugin-stderr-tail");
  });

  it(
    "grants read-manifest — Settings resolves a picked folder's " +
      "termx-plugin.json through it, and without the grant every folder reads " +
      "as 'no manifest found' with no way to tell that apart from a real one",
    () => {
      expect(capability.permissions).toContain("allow-plugin-read-manifest");
    },
  );
});
