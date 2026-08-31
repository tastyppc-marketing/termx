import { describe, expect, it } from "vitest";
import {
  expandEnv,
  isValidPluginId,
  parseManifest,
  parseManifestErrors,
  type PluginManifest,
} from "../manifest";

const showroomManifest = {
  manifest: 1,
  id: "showroom",
  name: "Showroom",
  icon: "🖼",
  start: { command: "node", args: ["server/showroom.js"] },
  singleton: true,
  discovery: {
    runtimeFile: "%APPDATA%\\Showroom\\runtime.json",
    healthPath: "/api/health",
  },
  panel: { path: "/" },
  requests: ["terminal.open"],
  connector: { wsPath: "/plugin" },
};

describe("plugin manifest", () => {
  it("parses the Showroom manifest and tolerates Phase 2 keys", () => {
    const expected: PluginManifest = {
      manifest: 1,
      id: "showroom",
      name: "Showroom",
      icon: "🖼",
      start: { command: "node", args: ["server/showroom.js"] },
      singleton: true,
      discovery: {
        runtimeFile: "%APPDATA%\\Showroom\\runtime.json",
        healthPath: "/api/health",
      },
      panel: { path: "/" },
    };

    expect(parseManifest(showroomManifest)).toEqual(expected);
  });

  it("rejects a manifest with a non-1 version", () => {
    expect(parseManifest({ ...showroomManifest, manifest: 2 })).toBeNull();
  });

  it("reports a missing start command by its field path", () => {
    const missingCommand = { ...showroomManifest, start: { args: [] } };

    expect(parseManifest(missingCommand)).toBeNull();
    expect(parseManifestErrors(missingCommand)).toContain("start.command");
  });

  it.each([
    ["an uppercase id", "Showroom"],
    ["an id starting with a hyphen", "-showroom"],
    ["an id with a dot", "show.room"],
    ["an id with a space", "show room"],
    ["an id with a path separator", "show/room"],
  ])("rejects %s by the id field path", (_label, id) => {
    const manifest = { ...showroomManifest, id };

    expect(parseManifest(manifest)).toBeNull();
    expect(parseManifestErrors(manifest)).toContain("id");
  });

  it("accepts hyphenated and digit-bearing ids", () => {
    expect(isValidPluginId("showroom")).toBe(true);
    expect(isValidPluginId("show-room-2")).toBe(true);
    expect(isValidPluginId("2fast")).toBe(true);
    expect(isValidPluginId("")).toBe(false);
    expect(isValidPluginId("SHOWROOM")).toBe(false);
  });

  it("requires a rooted discovery health path", () => {
    const manifest = {
      ...showroomManifest,
      discovery: { ...showroomManifest.discovery, healthPath: "api/health" },
    };

    expect(parseManifest(manifest)).toBeNull();
    expect(parseManifestErrors(manifest)).toContain("discovery.healthPath");
  });

  it("requires a rooted panel path", () => {
    const manifest = { ...showroomManifest, panel: { path: "termx" } };

    expect(parseManifest(manifest)).toBeNull();
    expect(parseManifestErrors(manifest)).toContain("panel.path");
  });

  it("expands Windows-style environment variables", () => {
    expect(
      expandEnv("%APPDATA%\\Showroom\\runtime.json", {
        APPDATA: "C:\\U\\x\\AppData\\Roaming",
      }),
    ).toBe("C:\\U\\x\\AppData\\Roaming\\Showroom\\runtime.json");
  });

  it("matches environment variable names case-insensitively like Windows", () => {
    expect(
      expandEnv("%appdata%\\Showroom\\runtime.json", {
        APPDATA: "C:\\U\\x\\AppData\\Roaming",
      }),
    ).toBe("C:\\U\\x\\AppData\\Roaming\\Showroom\\runtime.json");
    expect(expandEnv("%LocalAppData%\\a", { LOCALAPPDATA: "C:\\U\\x\\L" })).toBe(
      "C:\\U\\x\\L\\a",
    );
  });

  it("leaves unknown environment variables verbatim", () => {
    expect(expandEnv("%NOPE%\\a", {})).toBe("%NOPE%\\a");
    expect(expandEnv("%NOPE%\\a", { NOPEX: "x" })).toBe("%NOPE%\\a");
  });
});
