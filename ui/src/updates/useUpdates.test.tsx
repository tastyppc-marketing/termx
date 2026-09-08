import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useUpdates } from "./useUpdates";
const api=vi.hoisted(()=>({invoke:vi.fn(),getVersion:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
vi.mock("@tauri-apps/api/app",()=>({getVersion:api.getVersion}));
let root:Root; let value:ReturnType<typeof useUpdates>;
function Harness({enabled=true}:{enabled?:boolean}) { value=useUpdates(enabled); return null; }
const noRelease={status:"no-release",currentVersion:"0.2.0",latestVersion:null,releaseTag:null};
beforeEach(()=>{
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers(); root=createRoot(document.createElement("div"));
  api.getVersion.mockReset().mockResolvedValue("0.2.0"); api.invoke.mockReset().mockResolvedValue(noRelease);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.useRealTimers();});
it("reads the running version and reports an empty private release catalog",async()=>{
  await act(async()=>root.render(<Harness/>));
  expect(value.version).toBe("0.2.0"); expect(value.update).toEqual({kind:"checked",result:noRelease});
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith("check_for_updates");
});
it("keeps errors distinct and allows a manual retry",async()=>{
  api.invoke.mockRejectedValueOnce("Sign in to GitHub");
  await act(async()=>root.render(<Harness/>)); expect(value.update).toEqual({kind:"error",message:"Sign in to GitHub"});
  await act(async()=>value.check()); expect(value.update.kind).toBe("checked");
});
it("does not overlap requests or schedule checks after hiding the bar",async()=>{
  let finish!:(v:typeof noRelease)=>void;
  api.invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>root.render(<Harness/>));
  await act(async()=>{value.check();value.check();}); expect(api.invoke).toHaveBeenCalledOnce();
  await act(async()=>root.render(<Harness enabled={false}/>));
  await act(async()=>finish(noRelease));
  await act(async()=>{await vi.advanceTimersByTimeAsync(24*60*60*1000);});
  expect(api.invoke).toHaveBeenCalledOnce();
});
it("opens only the selected available release and reports opener failures",async()=>{
  api.invoke.mockResolvedValueOnce({...noRelease,status:"available",latestVersion:"0.3.0",releaseTag:"v0.3.0"});
  await act(async()=>root.render(<Harness/>));
  api.invoke.mockRejectedValueOnce("Browser unavailable");
  await act(async()=>value.open());
  expect(api.invoke).toHaveBeenLastCalledWith("open_update_release",{tag:"v0.3.0"});
  expect(value.update).toEqual({kind:"error",message:"Browser unavailable"});
});
