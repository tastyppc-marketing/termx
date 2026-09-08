import { useEffect, useState } from "react";
import type { WorkspaceController } from "../workspace/WorkspaceController";
import { tauriPaneAgentStatus, type PaneAgentStatus } from "../native/paneAgentStatus";
interface PaneStatus {
  probe: import("../host/client").SessionProbe | null;
  model: PaneAgentStatus | null;
}
const UNKNOWN: PaneStatus = { probe: null, model: null };

/** Poll only the focused shell; obsolete requests cannot decorate a new pane. */
export function useFocusedPaneStatus(controller: WorkspaceController, sessionId: number | null,
  pid: number | null, enabled: boolean): PaneStatus {
  const [state, setState] = useState<{sessionId:number;pid:number;value:PaneStatus} | null>(null);
  useEffect(() => {
    if (!enabled || sessionId === null || pid === null) return;
    let disposed=false; let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      let value: PaneStatus=UNKNOWN;
      try {
        const probe=await controller.probePane?.(sessionId! ) ?? null;
        if (disposed) return;
        const capture=probe?.alive && probe.busy
          ? await controller.rawConversationCapture?.(sessionId!) : null;
        if (disposed) return;
        const model=capture ? await tauriPaneAgentStatus(pid!,capture) : null;
        value={probe,model};
      } catch { /* Disconnected/older native shells have no trustworthy status. */ }
      if (!disposed) {
        setState({sessionId:sessionId!,pid:pid!,value});
        timer=setTimeout(() => void poll(),2000);
      }
    }
    void poll();
    return () => { disposed=true; clearTimeout(timer); };
  },[controller,sessionId,pid,enabled]);
  return enabled && state?.sessionId===sessionId && state?.pid===pid ? state.value : UNKNOWN;
}
