import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The Tauri config, found from the vitest root (the `ui` package). */
function configPath(): string {
  const fromRoot = resolve(process.cwd(), "src-tauri/tauri.conf.json");
  return existsSync(fromRoot) ? fromRoot : resolve(process.cwd(), "ui/src-tauri/tauri.conf.json");
}

/**
 * The CSP is declared in exactly one place and enforced by the webview, which
 * blocks a violation SILENTLY: a plugin panel whose origin is not in
 * `frame-src` renders as an empty rectangle with no error anywhere in the UI.
 * These assertions are the only thing that would catch the header being
 * trimmed, reordered into uselessness, or widened past loopback.
 */
const csp = (
  JSON.parse(readFileSync(configPath(), "utf8")) as {
    app: { security: { csp: string } };
  }
).app.security.csp;

/** One directive's source list, e.g. "frame-src" -> ["http://127.0.0.1:*", …]. */
function directive(name: string): string[] {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found === undefined ? [] : found.split(/\s+/).slice(1);
}

describe("content security policy", () => {
  it("keeps the app itself locked to its own bundle", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
    // The theme engine writes custom properties inline; scripts stay bundled.
    expect(directive("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp).not.toContain("script-src");
  });

  it(
    "frames plugin panels from loopback only — a panel is served by a local " +
      "process on an ephemeral port, so the port is a wildcard and the host " +
      "never is",
    () => {
      const sources = directive("frame-src");
      expect(sources).toContain("http://127.0.0.1:*");
      expect(sources).toContain("http://localhost:*");
      // No third host, and nothing off the machine.
      expect(sources).toHaveLength(2);
      expect(sources.some((source) => source.includes("https://"))).toBe(false);
      expect(sources).not.toContain("*");
    },
  );

  it(
    "leaves connect-src untouched by the plugin work — the health probe runs " +
      "in Rust, so the webview never needs to reach a plugin's HTTP port; " +
      "granting it here would hand every page in the app a loopback client",
    () => {
      const sources = directive("connect-src");
      expect(sources).toEqual(["'self'", "ws://127.0.0.1:*", "http://ipc.localhost"]);
      expect(sources.some((source) => source.startsWith("http://127.0.0.1"))).toBe(false);
      expect(sources.some((source) => source.startsWith("http://localhost"))).toBe(false);
    },
  );
});
