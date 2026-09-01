import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { tauriOpenFolder } from "../openFolder";

describe("open_folder invoke wrapper", () => {
  // Braces, not a concise body: `mockReset()` returns the mock, and vitest
  // calls a value returned from `beforeEach` as the teardown hook — which
  // would invoke the mock with no caller to await its result.
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes the path through under the command's argument name", async () => {
    invoke.mockResolvedValue(true);

    await expect(tauriOpenFolder("C:\\Dev\\TermX")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_folder", {
      path: "C:\\Dev\\TermX",
    });
  });

  it("reports false when the host declined to open anything", async () => {
    invoke.mockResolvedValue(false);

    await expect(tauriOpenFolder("C:\\gone")).resolves.toBe(false);
  });

  it(
    "swallows a rejected invoke — outside Tauri, or with the permission " +
      "missing, a click must be a quiet no-op rather than an exception " +
      "escaping the handler",
    async () => {
      invoke.mockRejectedValue(new Error("command open_folder not allowed"));

      await expect(tauriOpenFolder("C:\\Dev")).resolves.toBe(false);
    },
  );

  it("treats a non-boolean answer as 'nothing opened'", async () => {
    invoke.mockResolvedValue(undefined);

    await expect(tauriOpenFolder("C:\\Dev")).resolves.toBe(false);
  });
});
