import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UI = resolve(__dirname, "..", "..");
const ROOT = resolve(UI, "..");

/** The `version = "..."` line of a Cargo manifest's `[package]` table. */
function cargoVersion(path: string): string {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error(`no version in ${path}`);
  return match[1];
}

/**
 * Four manifests carry TermX's version and only `tools/version.ps1` is meant
 * to change them. The updater compares the running version (from
 * tauri.conf.json via Cargo) against release tags, so a drifted manifest
 * would make the app mis-detect its own version. This is the one guard.
 */
describe("version sync", () => {
  it("declares one version everywhere", () => {
    const conf = JSON.parse(readFileSync(resolve(UI, "src-tauri", "tauri.conf.json"), "utf8")) as {
      version: string;
    };
    const pkg = JSON.parse(readFileSync(resolve(UI, "package.json"), "utf8")) as { version: string };
    const versions = {
      tauriConf: conf.version,
      packageJson: pkg.version,
      uiCargo: cargoVersion(resolve(UI, "src-tauri", "Cargo.toml")),
      hostCargo: cargoVersion(resolve(ROOT, "host", "Cargo.toml")),
    };
    expect(new Set(Object.values(versions)).size, JSON.stringify(versions)).toBe(1);
    expect(versions.tauriConf).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
