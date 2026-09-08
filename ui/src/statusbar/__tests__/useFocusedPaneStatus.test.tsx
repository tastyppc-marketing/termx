import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useFocusedPaneStatus } from "../useFocusedPaneStatus";
import type { WorkspaceController } from "../../workspace/WorkspaceController";
const native = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../native/paneAgentStatus", () => ({ tauriPaneAgentStatus: native.status }));
let root: Root; let el: HTMLDivElement;
let status: ReturnType<typeof useFocusedPaneStatus>;
const probePane = vi.fn(); const rawConversationCapture = vi.fn();
const controller = { probePane, rawConversationCapture } as unknown as WorkspaceController;
function Harness({ id, enabled=true }: { id: number; enabled?: boolean }) {
  status=useFocusedPaneStatus(controller,id,id+100,enabled); return null;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers(); el=document.createElement("div"); root=createRoot(el);
  probePane.mockReset().mockResolvedValue({alive:true,busy:true});
  rawConversationCapture.mockReset().mockResolvedValue({termxSessionId:1,provider:"codex",id:"abc",atMs:100});
  native.status.mockReset().mockResolvedValue({provider:"codex",model:"model-one"});
});
afterEach(async()=> { await act(async()=>root.unmount()); vi.useRealTimers(); });
it("shows only the focused live LLM and clears it when the shell returns",async()=>{
  await act(async()=>root.render(<Harness id={1}/>));
  expect(status.model?.model).toBe("model-one");
  expect(native.status).toHaveBeenCalledWith(101,expect.objectContaining({termxSessionId:1}));
  probePane.mockResolvedValue({alive:true,busy:false});
  await act(async()=>{ await vi.advanceTimersByTimeAsync(2000); });
  expect(status.model).toBeNull(); expect(status.probe?.busy).toBe(false);
});
it("rejects stale responses after changing panes",async()=>{
  let finish!: (value: {provider:string;model:string})=>void;
  native.status.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>root.render(<Harness id={1}/>));
  probePane.mockResolvedValue({alive:true,busy:false});
  await act(async()=>root.render(<Harness id={2}/>));
  await act(async()=>finish({provider:"codex",model:"wrong-pane"}));
  expect(status.model).toBeNull(); expect(status.probe?.busy).toBe(false);
});
it("does not infer an LLM from a busy process and does not poll a hidden status bar",async()=>{
  native.status.mockResolvedValue(null);
  await act(async()=>root.render(<Harness id={1}/>)); expect(status.model).toBeNull();
  await act(async()=>root.render(<Harness id={1} enabled={false}/>));
  const calls=probePane.mock.calls.length;
  await act(async()=>{ await vi.advanceTimersByTimeAsync(10000); });
  expect(probePane).toHaveBeenCalledTimes(calls); expect(status.probe).toBeNull();
});
it("does not overlap polls and handles an unavailable host",async()=>{
  let finish!: (value:null)=>void;
  probePane.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>root.render(<Harness id={1}/>));
  await act(async()=>{ await vi.advanceTimersByTimeAsync(10000); });
  expect(probePane).toHaveBeenCalledOnce();
  await act(async()=>finish(null)); expect(status.probe).toBeNull();
  expect(native.status).not.toHaveBeenCalled();
});
