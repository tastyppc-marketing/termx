import { describe, expect, it } from "vitest";
import {
  isPathLikeQuery,
  mergeFolderResults,
  scoreFolder,
  splitForDisplay,
} from "../fuzzyScore";

describe("scoreFolder", () => {
  it("empty query matches everything at score zero", () => {
    expect(scoreFolder("", "C:\\Dev\\TermX")).toBe(0);
    expect(scoreFolder("   ", "C:\\Dev\\TermX")).toBe(0);
  });

  it("ranks leaf-prefix over leaf-substring over path matches", () => {
    const leafPrefix = scoreFolder("term", "C:\\Dev\\TermX")!;
    const leafInside = scoreFolder("erm", "C:\\Dev\\TermX")!;
    const pathOnly = scoreFolder("dev", "C:\\Dev\\TermX")!;
    expect(leafPrefix).toBeGreaterThan(leafInside);
    expect(leafInside).toBeGreaterThan(pathOnly);
  });

  it("requires every token and is case-insensitive", () => {
    expect(scoreFolder("dev termx", "C:\\Dev\\TermX")).not.toBeNull();
    expect(scoreFolder("dev missing", "C:\\Dev\\TermX")).toBeNull();
    expect(scoreFolder("TERMX", "c:\\dev\\termx")).not.toBeNull();
  });
});

describe("isPathLikeQuery", () => {
  it("detects drives, UNC, home, and separators", () => {
    expect(isPathLikeQuery("C:")).toBe(true);
    expect(isPathLikeQuery("C:\\De")).toBe(true);
    expect(isPathLikeQuery("\\\\server")).toBe(true);
    expect(isPathLikeQuery("~\\code")).toBe(true);
    expect(isPathLikeQuery("src/components")).toBe(true);
    expect(isPathLikeQuery("termx")).toBe(false);
    expect(isPathLikeQuery("")).toBe(false);
  });
});

describe("mergeFolderResults", () => {
  it("puts matching recents first, then unseen completions, deduped case-insensitively", () => {
    const rows = mergeFolderResults(
      "",
      ["C:\\Dev\\TermX", "C:\\Work"],
      ["c:\\dev\\termx", "C:\\Dev\\Other"],
    );
    expect(rows).toEqual([
      { path: "C:\\Dev\\TermX", kind: "recent" },
      { path: "C:\\Work", kind: "recent" },
      { path: "C:\\Dev\\Other", kind: "dir" },
    ]);
  });

  it("filters recents by score and respects the cap", () => {
    const recents = Array.from({ length: 20 }, (_, i) => `C:\\proj\\alpha${i}`);
    const rows = mergeFolderResults("alpha", recents, [], 5);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.kind === "recent")).toBe(true);

    const none = mergeFolderResults("zzz", recents, []);
    expect(none).toEqual([]);
  });

  it("keeps MRU order among equal-score recents", () => {
    const rows = mergeFolderResults(
      "proj",
      ["C:\\proj-b", "C:\\proj-a"],
      [],
    );
    expect(rows.map((row) => row.path)).toEqual(["C:\\proj-b", "C:\\proj-a"]);
  });
});

describe("splitForDisplay", () => {
  it("splits parent and leaf", () => {
    expect(splitForDisplay("C:\\Dev\\TermX")).toEqual({
      parent: "C:\\Dev\\",
      leaf: "TermX",
    });
    expect(splitForDisplay("C:\\")).toEqual({ parent: "", leaf: "C:\\" });
  });
});
