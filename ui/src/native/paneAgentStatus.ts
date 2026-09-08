import { invoke } from "@tauri-apps/api/core";
import type { ConversationCapture } from "../conversations/captures";

export interface PaneAgentStatus {
  provider: "claude" | "codex";
  model: string | null;
}

/** Missing native support or unverifiable process identity means no status. */
export async function tauriPaneAgentStatus(
  shellPid: number,
  capture: ConversationCapture,
): Promise<PaneAgentStatus | null> {
  try {
    const result = await invoke<unknown>("pane_agent_status", { shellPid, capture });
    if (result === null || typeof result !== "object") return null;
    const raw = result as Record<string, unknown>;
    if (raw.provider !== "claude" && raw.provider !== "codex") return null;
    if (raw.model !== null && (typeof raw.model !== "string" || !raw.model.trim()
      || [...raw.model].length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(raw.model))) return null;
    return { provider: raw.provider, model: raw.model as string | null };
  } catch {
    return null;
  }
}
