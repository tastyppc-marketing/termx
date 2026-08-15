import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Registering `onCloseRequested` makes the JS side responsible for actually
 * closing: the Tauri wrapper calls `destroy()` after the handler runs, and our
 * CloseGuard calls `close()` itself. Both are ACL-gated and NOT part of
 * `core:default` (which only grants window getters) — without these grants
 * every close path fails silently and the window can only be killed from the
 * task manager.
 */
describe("window close capability", () => {
  it("grants the close/destroy permissions the close guard depends on", () => {
    // Vitest runs with cwd at ui/, and import.meta.url is not file: in jsdom.
    const path = join(process.cwd(), "src-tauri", "capabilities", "default.json");
    const capability = JSON.parse(readFileSync(path, "utf8")) as {
      permissions: string[];
    };
    expect(capability.permissions).toContain("core:window:allow-close");
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });
});
