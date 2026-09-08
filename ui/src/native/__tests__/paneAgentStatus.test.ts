import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationCapture } from "../../conversations/captures";
import { tauriPaneAgentStatus } from "../paneAgentStatus";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const capture: ConversationCapture = { provider: "claude", id: "abc-123", termxSessionId: 7, cwd: null, atMs: 1000 };
beforeEach(() => invoke.mockReset());

it("keeps opaque models and an explicitly unknown model from the native probe", async () => {
  invoke.mockResolvedValue({ provider: "claude", model: "gpt-6-astra" });
  expect(await tauriPaneAgentStatus(100, capture)).toEqual({ provider: "claude", model: "gpt-6-astra" });
  invoke.mockResolvedValue({ provider: "codex", model: null });
  expect(await tauriPaneAgentStatus(100, capture)).toEqual({ provider: "codex", model: null });
});

it("failed or malformed native status never becomes a guessed model", async () => {
  invoke.mockRejectedValue(new Error("not available"));
  expect(await tauriPaneAgentStatus(100, capture)).toBeNull();
  for (const result of [null, {}, { provider: "unknown", model: "x" }, { provider: "claude", model: "x".repeat(129) }, { provider: "claude", model: "bad\nmodel" }]) {
    invoke.mockResolvedValue(result);
    expect(await tauriPaneAgentStatus(100, capture)).toBeNull();
  }
});
