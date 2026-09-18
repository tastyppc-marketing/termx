import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useUpdates } from "./useUpdates";
import type { UpdatePolicy, UpdateResult } from "./types";
const api=vi.hoisted(()=>({invoke:vi.fn(),getVersion:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:api.invoke}));
vi.mock("@tauri-apps/api/app",()=>({getVersion:api.getVersion}));
let root:Root; let value:ReturnType<typeof useUpdates>;
interface HarnessProps { policy?: UpdatePolicy; snoozedVersion?: string | null; onSnooze?: (v: string) => void; onHostChangeInstall?: () => void }
const onSnooze=vi.fn();
function Harness({policy="ask",snoozedVersion=null,onSnooze:snooze=onSnooze,onHostChangeInstall}:HarnessProps) {
  value=useUpdates({policy,snoozedVersion,onSnooze:snooze,...(onHostChangeInstall?{onHostChangeInstall}:{})}); return null;
}
const noRelease:UpdateResult={status:"no-release",currentVersion:"0.2.0",latestVersion:null,releaseTag:null,
  forced:false,hostChanged:false,sha256:null,assetName:null,notesUrl:null};
const available:UpdateResult={...noRelease,status:"available",latestVersion:"0.3.0",releaseTag:"v0.3.0",sha256:"a".repeat(64),
  assetName:"TermX-Setup-0.3.0-x64.exe",notesUrl:"https://github.com/tastyppc-marketing/termx/releases/tag/v0.3.0"};
const calls=()=>api.invoke.mock.calls.map(c=>c[0]);
beforeEach(()=>{
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers(); root=createRoot(document.createElement("div")); onSnooze.mockReset();
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
it("does not overlap requests",async()=>{
  let finish!:(v:UpdateResult)=>void;
  api.invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await act(async()=>root.render(<Harness/>));
  await act(async()=>{value.check();value.check();}); expect(api.invoke).toHaveBeenCalledOnce();
  await act(async()=>finish(noRelease));
  expect(value.update).toEqual({kind:"checked",result:noRelease});
});
it("checks even when the status bar is hidden",async()=>{
  await act(async()=>root.render(<Harness/>));
  expect(api.invoke).toHaveBeenCalledWith("check_for_updates");
});
it("opens the release notes for the selected release and reports opener failures without losing the result",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness/>));
  expect(value.update.kind).toBe("ready");
  api.invoke.mockRejectedValueOnce("Browser unavailable");
  await act(async()=>value.open());
  expect(api.invoke).toHaveBeenLastCalledWith("open_update_release",{tag:"v0.3.0"});
  expect(value.update).toEqual({kind:"error",message:"Browser unavailable",result:available});
});
it("downloads then installs on request, passing the release identity through",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\TermX-Setup-0.3.0-x64.exe").mockResolvedValueOnce(undefined);
  await act(async()=>root.render(<Harness/>));
  await act(async()=>value.download());
  expect(api.invoke).toHaveBeenNthCalledWith(2,"download_update",{tag:"v0.3.0",assetName:"TermX-Setup-0.3.0-x64.exe",sha256:"a".repeat(64)});
  expect(value.update).toEqual({kind:"ready",result:available,installerPath:"C:\\u\\TermX-Setup-0.3.0-x64.exe"});
  await act(async()=>value.install());
  expect(api.invoke).toHaveBeenNthCalledWith(3,"install_update",{installerPath:"C:\\u\\TermX-Setup-0.3.0-x64.exe"});
  expect(value.update.kind).toBe("installing");
});
it("ask policy downloads in the background but never installs on its own",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness policy="ask"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(calls()).toEqual(["check_for_updates","download_update"]);
  expect(value.update.kind).toBe("ready");
});
it("auto policy downloads in the background and installs at launch when ready and not forced",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe").mockResolvedValueOnce(undefined);
  await act(async()=>root.render(<Harness policy="auto"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(calls()).toEqual(["check_for_updates","download_update","install_update"]);
});
it("a snoozed optional version is downloaded but not installed at launch",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness policy="auto" snoozedVersion="0.3.0"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(calls()).toEqual(["check_for_updates","download_update"]);
  expect(value.update.kind).toBe("ready");
});
it("a forced update is never auto-installed at launch; the modal owns that click",async()=>{
  api.invoke.mockResolvedValueOnce({...available,forced:true}).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness policy="auto"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(calls()).toEqual(["check_for_updates","download_update"]);
});
it("a later poll downloads but never installs mid-work, even on auto",async()=>{
  await act(async()=>root.render(<Harness policy="auto"/>));
  expect(calls()).toEqual(["check_for_updates"]);
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>{await vi.advanceTimersByTimeAsync(6*60*60*1000);});
  expect(calls()).toEqual(["check_for_updates","check_for_updates","download_update"]);
  expect(value.update.kind).toBe("ready");
});
it("keeps the result on a failed download so the pill still names the version",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockRejectedValueOnce("Digest mismatch");
  await act(async()=>root.render(<Harness policy="auto"/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  expect(value.update).toEqual({kind:"error",message:"Digest mismatch",result:available});
  expect(calls()).toEqual(["check_for_updates","download_update"]);
});
it("retries a failed download on request",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockRejectedValueOnce("offline").mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness/>));
  expect(value.update.kind).toBe("error");
  await act(async()=>value.download());
  expect(value.update).toEqual({kind:"ready",result:available,installerPath:"C:\\u\\x.exe"});
});
it("snooze reports the offered version to the caller",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe");
  await act(async()=>root.render(<Harness/>));
  act(()=>value.snooze());
  expect(onSnooze).toHaveBeenCalledExactlyOnceWith("0.3.0");
});
it("stops the host before installing a host-changing update, and only then",async()=>{
  const order:string[]=[];
  const onHostChangeInstall=vi.fn(()=>{order.push("host");});
  api.invoke.mockImplementation(async(cmd:string)=>{ order.push(cmd);
    if(cmd==="check_for_updates") return {...available,hostChanged:true};
    if(cmd==="download_update") return "C:\\u\\x.exe"; return undefined; });
  await act(async()=>root.render(<Harness onHostChangeInstall={onHostChangeInstall}/>));
  await act(async()=>value.install());
  expect(order).toEqual(["check_for_updates","download_update","host","install_update"]);
  order.length=0; onHostChangeInstall.mockClear();
  api.invoke.mockImplementation(async(cmd:string)=>{ order.push(cmd);
    if(cmd==="check_for_updates") return available;
    if(cmd==="download_update") return "C:\\u\\x.exe"; return undefined; });
  await act(async()=>root.unmount()); root=createRoot(document.createElement("div"));
  await act(async()=>root.render(<Harness onHostChangeInstall={onHostChangeInstall}/>));
  await act(async()=>value.install());
  expect(onHostChangeInstall).not.toHaveBeenCalled();
  expect(order).toEqual(["check_for_updates","download_update","install_update"]);
});
it("reports an installer failure and keeps the result",async()=>{
  api.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce("C:\\u\\x.exe").mockRejectedValueOnce("Installer exited with code 2");
  await act(async()=>root.render(<Harness/>));
  await act(async()=>value.install());
  expect(value.update).toEqual({kind:"error",message:"Installer exited with code 2",result:available});
});
