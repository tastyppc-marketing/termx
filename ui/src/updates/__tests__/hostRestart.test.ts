import { describe, expect, it } from "vitest";
import { needsHostRestart } from "../hostRestart";
describe("needsHostRestart", () => {
  it("is false when versions match or the host was not part of the update", () => {
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.3.0", hostChanged: true })).toBe(false);
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.2.0", hostChanged: false })).toBe(false);
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: null, hostChanged: true })).toBe(false);
  });
  it("is true for an older daemon after a host-changing update", () => {
    expect(needsHostRestart({ uiVersion: "0.3.0", hostVersion: "0.2.0", hostChanged: true })).toBe(true);
  });
  it("is false before the UI knows its own version", () => {
    expect(needsHostRestart({ uiVersion: "", hostVersion: "0.2.0", hostChanged: true })).toBe(false);
  });
});
