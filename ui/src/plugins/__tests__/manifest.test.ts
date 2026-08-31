import { describe, expect, it } from "vitest";
import {
  expandEnv,
  parseManifest,
  parseManifestErrors,
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
    expect(parseManifest(showroomManifest)).toMatchObject({
      id: "showroom",
      singleton: true,
      discovery: { healthPath: "/api/health" },
    });
  });

  it("rejects a manifest with a non-1 version", () => {
    expect(parseManifest({ ...showroomManifest, manifest: 2 })).toBeNull();
  });

  it("reports a missing start command by its field path", () => {
    const missingCommand = { ...showroomManifest, start: { args: [] } };

    expect(parseManifest(missingCommand)).toBeNull();
    expect(parseManifestErrors(missingCommand)).toContain("start.command");
  });

  it("expands Windows-style environment variables", () => {
    expect(
      expandEnv("%APPDATA%\\Showroom\\runtime.json", {
        APPDATA: "C:\\U\\x\\AppData\\Roaming",
      }),
    ).toBe("C:\\U\\x\\AppData\\Roaming\\Showroom\\runtime.json");
  });

  it("leaves unknown environment variables verbatim", () => {
    expect(expandEnv("%NOPE%\\a", {})).toBe("%NOPE%\\a");
  });
});
