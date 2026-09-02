import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLUGIN_MIN_SIZE,
  DEFAULT_PLUGIN_SURFACES,
  expandEnv,
  isValidPluginId,
  minSizeOf,
  parseManifest,
  parseManifestErrors,
  parseManifestWarnings,
  surfacesOf,
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
      surfaces: { default: "tab", allowed: ["tab", "split"] },
      minSize: { width: 320, height: 200 },
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

/**
 * Placement (menubar spec): where a plugin is allowed to open, and how small a
 * box it can still be itself in. Both fields are OPTIONAL and every malformed
 * shape falls back rather than failing the parse — a plugin that predates the
 * fields, or ships a typo in them, must keep opening exactly as it did.
 */
describe("plugin manifest placement", () => {
  it("defaults an absent placement to a tab-or-split plugin at 320x200", () => {
    const manifest = parseManifest(showroomManifest)!;

    expect(manifest.surfaces).toEqual({ default: "tab", allowed: ["tab", "split"] });
    expect(manifest.minSize).toEqual({ width: 320, height: 200 });
    expect(DEFAULT_PLUGIN_SURFACES).toEqual({ default: "tab", allowed: ["tab", "split"] });
    expect(DEFAULT_PLUGIN_MIN_SIZE).toEqual({ width: 320, height: 200 });
  });

  it("keeps a declared placement", () => {
    const raw = {
      ...showroomManifest,
      surfaces: { default: "split", allowed: ["tab", "split", "window"] },
      minSize: { width: 360, height: 240 },
    };
    const manifest = parseManifest(raw)!;

    expect(manifest.surfaces).toEqual({
      default: "split",
      allowed: ["tab", "split", "window"],
    });
    expect(manifest.minSize).toEqual({ width: 360, height: 240 });
    expect(parseManifestWarnings(raw)).toEqual([]);
  });

  it("warns and falls back to the first allowed surface when the default is not among them", () => {
    const raw = {
      ...showroomManifest,
      surfaces: { default: "window", allowed: ["split", "tab"] },
    };
    const manifest = parseManifest(raw)!;

    expect(manifest.surfaces).toEqual({ default: "split", allowed: ["split", "tab"] });
    expect(parseManifestWarnings(raw)).toEqual([
      'surfaces.default "window" is not in surfaces.allowed; using "split".',
    ]);
  });

  it("drops surfaces it does not know, and warns when that orphans the default", () => {
    const raw = {
      ...showroomManifest,
      surfaces: { default: "sidebar", allowed: ["tab", "sidebar", "window"] },
    };
    const manifest = parseManifest(raw)!;

    expect(manifest.surfaces).toEqual({ default: "tab", allowed: ["tab", "window"] });
    expect(parseManifestWarnings(raw)).toEqual([
      'surfaces.default "sidebar" is not in surfaces.allowed; using "tab".',
    ]);
  });

  it("de-duplicates the allowed list, keeping first appearance", () => {
    const manifest = parseManifest({
      ...showroomManifest,
      surfaces: { default: "window", allowed: ["window", "tab", "window"] },
    })!;

    expect(manifest.surfaces).toEqual({ default: "window", allowed: ["window", "tab"] });
  });

  it.each([
    ["a non-object surfaces", 5],
    ["a null surfaces", null],
    ["an empty allowed list", { default: "tab", allowed: [] }],
    ["an allowed list of only unknown surfaces", { default: "tab", allowed: ["dock"] }],
    ["a missing allowed list", { default: "window" }],
    ["a non-string default", { default: 7, allowed: ["tab", "split"] }],
  ])("falls back to the default placement for %s", (_label, surfaces) => {
    const manifest = parseManifest({ ...showroomManifest, surfaces });

    expect(manifest).not.toBeNull();
    expect(manifest!.surfaces).toEqual({ default: "tab", allowed: ["tab", "split"] });
  });

  it.each([
    ["a non-object minSize", "big", 320],
    ["a zero width", { width: 0, height: 240 }, 320],
    ["a negative height", { width: 360, height: -1 }, 360],
    ["a non-finite width", { width: Number.POSITIVE_INFINITY, height: 240 }, 320],
    ["a string height", { width: 360, height: "240" }, 360],
  ])("keeps only the usable half of %s", (_label, minSize, expectedWidth) => {
    const resolved = parseManifest({ ...showroomManifest, minSize })!.minSize!;

    // Whatever half WAS usable survives; the rest takes the default.
    expect(resolved.width).toBe(expectedWidth);
    expect(resolved.height).toBeGreaterThan(0);
  });

  it("resolves placement for a manifest that never went through the parser", () => {
    const handwritten: PluginManifest = {
      manifest: 1,
      id: "notes",
      name: "Notes",
      icon: "N",
      start: { command: "node", args: [] },
      singleton: false,
      discovery: { runtimeFile: "C:\notes\runtime.json", healthPath: "/health" },
      panel: { path: "/" },
    };

    expect(surfacesOf(handwritten)).toEqual({ default: "tab", allowed: ["tab", "split"] });
    expect(minSizeOf(handwritten)).toEqual({ width: 320, height: 200 });
    expect(
      surfacesOf({ ...handwritten, surfaces: { default: "window", allowed: ["window"] } }),
    ).toEqual({ default: "window", allowed: ["window"] });
  });

  it("still refuses a manifest that is broken elsewhere, placement or no placement", () => {
    expect(
      parseManifest({
        ...showroomManifest,
        name: "",
        surfaces: { default: "tab", allowed: ["tab"] },
      }),
    ).toBeNull();
  });
});
