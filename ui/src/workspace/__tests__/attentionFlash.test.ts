import { describe, expect, it } from "vitest";
import { decideAttentionFlash } from "../attentionFlash";

const NONE: ReadonlySet<string> = new Set();

describe("decideAttentionFlash", () => {
  it("flashes when a tab finishes while the window is in the background", () => {
    const decision = decideAttentionFlash(["tab-1"], false, NONE);
    expect(decision.flash).toBe(true);
    expect([...decision.announced]).toEqual(["tab-1"]);
  });

  it("does not flash again for a tab already announced", () => {
    const first = decideAttentionFlash(["tab-1"], false, NONE);
    const second = decideAttentionFlash(["tab-1"], false, first.announced);
    expect(second.flash).toBe(false);
  });

  it(
    "flashes for a second tab even while an older one is still marked — " +
      "the latching bug that killed every notification after the first",
    () => {
      // tab-1 finished, was announced, and the user never visited it, so it
      // stays attentive forever. A global "any tab attentive" flag would be
      // stuck high here and tab-2 would never be announced.
      const first = decideAttentionFlash(["tab-1"], false, NONE);
      expect(first.flash).toBe(true);

      const second = decideAttentionFlash(["tab-1", "tab-2"], false, first.announced);
      expect(second.flash).toBe(true);

      const third = decideAttentionFlash(
        ["tab-1", "tab-2", "tab-3"],
        false,
        second.announced,
      );
      expect(third.flash).toBe(true);
    },
  );

  it("never flashes while the window has focus, and absorbs what is marked", () => {
    const focused = decideAttentionFlash(["tab-1"], true, NONE);
    expect(focused.flash).toBe(false);
    expect([...focused.announced]).toEqual(["tab-1"]);

    // Alt-tabbing away must not fire for the tab that finished under the
    // user's nose a moment ago.
    expect(decideAttentionFlash(["tab-1"], false, focused.announced).flash).toBe(false);
  });

  it("announces a visited tab again when it finishes a second job", () => {
    const first = decideAttentionFlash(["tab-1"], false, NONE);
    // Visited: the mark cleared, so the id drops out of the attentive set.
    const cleared = decideAttentionFlash([], false, first.announced);
    expect(cleared.flash).toBe(false);
    expect(cleared.announced.size).toBe(0);

    expect(decideAttentionFlash(["tab-1"], false, cleared.announced).flash).toBe(true);
  });

  it("nothing attentive means nothing to say", () => {
    expect(decideAttentionFlash([], false, NONE).flash).toBe(false);
    expect(decideAttentionFlash([], true, new Set(["tab-1"])).flash).toBe(false);
  });
});
