import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../host/protocol";
import type { SessionProbe } from "../../host/client";
import type { ConversationCapture } from "../../conversations/captures";
import { createLayoutStore } from "../../state/store";
import type { Layout } from "../../state/layout";
import type { HubSessionSnapshot } from "../AttachmentHub";
import { WorkspaceController, type WorkspaceAttachmentHub, type WorkspaceHostClient } from "../WorkspaceController";

const controllers: WorkspaceController[] = [];
afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()));

function harness(profile = "powershell") {
  const session = (id: number): SessionInfo => ({
    id, profile, cwd: "C:\\old", cols: 120, rows: 30, alive: true, pid: 1000 + id,
  });
  const store = createLayoutStore({
    version: 3, auxWindows: {}, windowNames: {}, groups: {},
    rootItems: [{ kind: "tab", id: "tab-1" }], activeTabId: "tab-1",
    tabs: { "tab-1": { id: "tab-1", title: null, color: "blue", fill: "off", split: {
      kind: "split", dir: "row", sizes: [0.5, 0.5],
      children: [{ kind: "pane", sessionId: 1 }, { kind: "pane", sessionId: 2 }],
    } } },
  } satisfies Layout);
  const probe = vi.fn(async ():Promise<SessionProbe> => ({ alive: true, busy: false, at_prompt:true,prompt_id:"prompt-1" }));
  const changeDir=vi.fn(async()=>true);
  let closed: ((event: { sessionId: number }) => void) | undefined;
  const client: WorkspaceHostClient = {
    createSession: vi.fn(async () => session(3)), closeSession: vi.fn(async () => undefined),
    onSessionExited: () => () => undefined,
    onSessionClosed: (listener) => { closed = listener; return () => undefined; },
    onError: () => () => undefined, probeSession: probe,changeDirectory:changeDir,
  };
  const hub = (id: number): HubSessionSnapshot => ({
    sessionId: id, hostAttached: true, terminalAttached: true, active: false, unread: false,
    settled: true, settledAt: 1234, exited: false, exitCode: null, lostScrollback: false,
    attachError: null, suspended: false, attachGeneration: 0, oldestOffset: 0n,
  });
  const hubState = { sessions: { 1: hub(1), 2: hub(2) } };
  const sendInput = vi.fn(() => true);
  const markSeen = vi.fn();
  const attachments: WorkspaceAttachmentHub = {
    sendInput, markSeen, getSnapshot: () => hubState, subscribe: () => () => undefined,
    attachSession: vi.fn(async () => undefined), markExited: vi.fn(), forgetSession: vi.fn(),
    attach: vi.fn(), onError: () => () => undefined, close: vi.fn(),
  };
  const pickFolder = vi.fn(async (): Promise<string | null> => "C:\\new folder");
  const dirExists = vi.fn(async () => true);
  const captures=new Map<number,ConversationCapture>();
  const controller = new WorkspaceController({
    client, store, attachments, sessions: [session(1), session(2)], pickFolder, dirExists,
    rawCaptureFor: id=>captures.get(id) ?? null,
    probeCapturedAgent:async()=>({provider:"claude",model:null}),
    markCaptureAmbiguous:async(capture)=>{captures.set(capture.termxSessionId,capture);},
    persistence: {
      getSnapshot: () => ({ saving: false, error: null }), subscribe: () => () => undefined,
      record: () => undefined, flush: async () => undefined, dispose: vi.fn(),
    },
  });
  controllers.push(controller);
  return { controller, probe, sendInput, changeDir, pickFolder, dirExists, markSeen, hubState, captures,
    close: (id: number) => closed?.({ sessionId: id }) };
}

describe("pane attention", () => {
  it("does not attribute a shared conversation transcript's model to either live pane", async () => {
    const h=harness();
    const capture:ConversationCapture={termxSessionId:1,provider:"claude",id:"abc-123",cwd:"C:\\work",atMs:1000,
      model:"model-one",transcriptPath:"C:\\sessions\\abc-123.jsonl",launcherPid:88,launcherCreatedAt:"134330888880000001"};
    h.captures.set(1,capture);
    expect(await h.controller.rawConversationCapture(1)).toEqual(capture);
    h.captures.set(2,{...capture,termxSessionId:2,launcherPid:89,model:"model-two"});
    expect(await h.controller.rawConversationCapture(1)).toMatchObject({model:null,transcriptPath:null,launcherPid:88});
    expect(await h.controller.rawConversationCapture(2)).toMatchObject({model:null,transcriptPath:null,launcherPid:89});
    h.close(2);
    expect(await h.controller.rawConversationCapture(1)).toMatchObject({model:null,transcriptPath:null});
    expect(h.captures.get(1)?.modelAmbiguous).toBe(true);
  });
  it("acknowledges only visible panes and retains minimized completion", () => {
    const h = harness();
    h.controller.markTabSeen("tab-1", [1, 999]);
    expect(h.markSeen.mock.calls).toEqual([[1]]);
    expect(h.controller.paneActivity("tab-1")[2]).toEqual({ activity: "attention", attentionSince: 1234 });
  });
  it("reports streaming and unread activity individually", () => {
    const h = harness();
    Object.assign(h.hubState.sessions[1], { settled: false, active: true });
    Object.assign(h.hubState.sessions[2], { settled: false, unread: true });
    expect(h.controller.paneActivity("tab-1")).toEqual({
      1: { activity: "active", attentionSince: null }, 2: { activity: "unread", attentionSince: null },
    });
    h.controller.markTabSeen("tab-1", []);
    expect(h.markSeen).not.toHaveBeenCalled();
  });
});

describe("changeDirectory", () => {
  it("picks a native folder and uses a guarded host action after checking the same prompt twice", async () => {
    const h = harness();
    h.pickFolder.mockResolvedValue("C:\\O'Brien [work]\\$project");
    expect(await h.controller.changeDirectory(1)).toBe(true);
    expect(h.pickFolder).toHaveBeenCalledWith({ title: "Open folder in this terminal", defaultPath: "C:\\old" });
    expect(h.probe.mock.calls).toEqual([[1], [1]]);
    expect(h.changeDir).toHaveBeenCalledWith(1,1001,"prompt-1","C:\\O'Brien [work]\\$project");
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.controller.sessionCwd(1)).toBe("C:\\old"); // Only the shell's report updates cwd.
  });
  it("does not offer an unverified cmd prompt", async () => {
    const h = harness("cmd");
    h.pickFolder.mockResolvedValue("D:\\A & B");
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.pickFolder).not.toHaveBeenCalled();
    expect(h.changeDir).not.toHaveBeenCalled();
  });
  it("cancellation sends nothing", async () => {
    const h = harness(); h.pickFolder.mockResolvedValue(null);
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it("does not open the picker while an LLM or another child is running", async () => {
    const h = harness(); h.probe.mockResolvedValue({ alive: true, busy: true });
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.pickFolder).not.toHaveBeenCalled(); expect(h.sendInput).not.toHaveBeenCalled();
  });
  it("refuses when the shell becomes busy while the picker is open", async () => {
    const h = harness(); h.probe.mockResolvedValueOnce({ alive: true, busy: false }).mockResolvedValue({ alive: true, busy: true });
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it("refuses in-process work and legacy hosts that cannot prove a clear prompt",async()=>{
    for(const at_prompt of [false,undefined]) {
      const h=harness(); h.probe.mockResolvedValue({alive:true,busy:false,at_prompt});
      expect(await h.controller.changeDirectory(1)).toBe(false);
      expect(h.pickFolder).not.toHaveBeenCalled(); expect(h.changeDir).not.toHaveBeenCalled();
    }
  });
  it("refuses a new prompt generation or a rejected atomic host guard",async()=>{
    const h=harness();h.probe.mockResolvedValueOnce({alive:true,busy:false,at_prompt:true,prompt_id:"first"})
      .mockResolvedValue({alive:true,busy:false,at_prompt:true,prompt_id:"second"});
    expect(await h.controller.changeDirectory(1)).toBe(false);expect(h.changeDir).not.toHaveBeenCalled();
    const raced=harness();raced.changeDir.mockResolvedValue(false);
    expect(await raced.controller.changeDirectory(1)).toBe(false);expect(raced.sendInput).not.toHaveBeenCalled();
  });
  it.each(["closed", "disposed", "focus", "disconnected"])("refuses a target that becomes %s during the dialog", async (change) => {
    const h = harness();
    h.pickFolder.mockImplementation(async () => {
      if (change === "closed") h.close(1);
      if (change === "disposed") h.controller.dispose();
      if (change === "focus") h.controller.setFocusedPane(() => 2);
      if (change === "disconnected") h.hubState.sessions[1].suspended = true;
      return "C:\\new";
    });
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it.each(["old host", "dead"])("does not send when probe reports %s", async (failure) => {
    const h = harness();
    if (failure === "old host") h.probe.mockRejectedValue(new Error("Unknown command"));
    else h.probe.mockResolvedValue({ alive: false, busy: false });
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it.each(["relative", "C:\\bad\rcommand", "C:\\bad\u0000path", 'C:\\bad"path'])("refuses unsafe directory %j", async (path) => {
    const h = harness(); h.pickFolder.mockResolvedValue(path);
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it.each(["C:\\%USERNAME%", "C:\\!name!"])("refuses cmd expansions in %s", async (path) => {
    const h = harness("cmd"); h.pickFolder.mockResolvedValue(path);
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it("refuses unsupported profiles and missing folders", async () => {
    const unsupported = harness("wsl");
    expect(await unsupported.controller.changeDirectory(1)).toBe(false);
    expect(unsupported.pickFolder).not.toHaveBeenCalled();
    const h = harness(); h.dirExists.mockResolvedValue(false);
    expect(await h.controller.changeDirectory(1)).toBe(false);
    expect(h.sendInput).not.toHaveBeenCalled();
  });
  it("coalesces repeated clicks while a picker is open", async () => {
    const h = harness();
    let release!: (path: string) => void;
    h.pickFolder.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = h.controller.changeDirectory(1);
    await vi.waitFor(() => expect(h.pickFolder).toHaveBeenCalledOnce());
    expect(await h.controller.changeDirectory(1)).toBe(false);
    release("C:\\new"); await first;
    expect(h.changeDir).toHaveBeenCalledOnce();
    expect(h.sendInput).not.toHaveBeenCalled();
  });
});
