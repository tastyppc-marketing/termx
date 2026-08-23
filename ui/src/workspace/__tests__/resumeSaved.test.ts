/**
 * `WorkspaceController.resumeSaved` (saved-sessions spec §"Resume flow").
 *
 * Two shapes of resume live here: REATTACH (the daemon still runs the terminal
 * the save came from, so nothing is created and nothing is typed) and FRESH
 * RESTORE (a new shell in the saved folder, then the provider's resume command
 * once the prompt reports). The refusal paths — a vanished folder, an id that
 * is not a bare token — are proven to stop before any terminal exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { emptyLayout, type LayoutV2 } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import type { DirExists } from "../../conversations/resume";
import { RESUME_PROMPT_TIMEOUT_MS } from "../../conversations/resume";
import type { LlmSessionRecord } from "../../conversations/types";
import type { SavedProvider, SavedSession } from "../../saved/types";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";

function saved(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: "saved-1",
    name: "TermX daemon work",
    cwd: "C:\\Dev\\TermX",
    conversation: { provider: "claude", id: CLAUDE_ID, title: "Daemon work" },
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  };
}

function session(id: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd: "C:\\Dev\\TermX",
    cols: 120,
    rows: 30,
    alive: true,
    pid: 4000 + id,
    ...overrides,
  };
}

/** A layout holding one tab over `sessionId`, with nothing active yet. */
function layoutWithTab(tabId: string, sessionId: number): LayoutV2 {
  const layout = emptyLayout();
  layout.tabs[tabId] = {
    id: tabId,
    title: null,
    color: "blue",
    fill: "off",
    split: { kind: "pane", sessionId },
  };
  layout.rootItems = [{ kind: "tab", id: tabId }];
  layout.activeTabId = null;
  return layout;
}

/** Yield long enough for every awaited step of a resume to settle. */
async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

function harness(options: {
  settings?: Partial<TermxSettings>;
  dirExists?: DirExists;
  sessions?: readonly SessionInfo[];
  layout?: LayoutV2;
  createSession?: (cwd: string | null) => Promise<SessionInfo>;
  /** The daemon's busy-probe answer. Omitted = a client without the method
   * (an older daemon), "reject" = the probe call fails. */
  probe?: { alive: boolean; busy: boolean } | "reject";
} = {}) {
  const exitListeners = new Set<
    (event: { sessionId: number; exitCode: number | null }) => void
  >();
  const createdCwds: Array<string | null> = [];
  const createdSessionIds: number[] = [];
  const writes: Array<[number, string | Uint8Array]> = [];
  let nextSessionId = 50;

  const createSession = vi.fn(
    async (createOptions: {
      profile: string | null;
      cwd: string | null;
      cols: number;
      rows: number;
    }): Promise<SessionInfo> => {
      createdCwds.push(createOptions.cwd);
      const created = options.createSession
        ? await options.createSession(createOptions.cwd)
        : session(nextSessionId++, {
            profile: createOptions.profile ?? "powershell",
            cwd: createOptions.cwd,
            cols: createOptions.cols,
            rows: createOptions.rows,
          });
      createdSessionIds.push(created.id);
      return created;
    },
  );

  const probeSession =
    options.probe === undefined
      ? undefined
      : vi.fn(async (_sessionId: number) => {
          if (options.probe === "reject") {
            throw new Error("Host request failed (probe_session): parse");
          }
          return options.probe!;
        });
  const client: WorkspaceHostClient = {
    createSession,
    closeSession: vi.fn(async () => undefined),
    onSessionExited(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
    ...(probeSession ? { probeSession } : {}),
  };

  const persistence: WorkspacePersistence = {
    getSnapshot: () => ({ saving: false, error: null }),
    subscribe: () => () => undefined,
    record: vi.fn(),
    flush: async () => undefined,
    dispose: vi.fn(),
  };

  const attachments: WorkspaceAttachmentHub = {
    getSnapshot: () => ({ sessions: {} }),
    subscribe: () => () => undefined,
    attachSession: vi.fn(async () => undefined),
    markExited: vi.fn(),
    forgetSession: vi.fn(),
    attach: vi.fn(async (sessionId: number) => ({
      sessionId,
      nextOffset: 0n,
      sendInput: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
    } satisfies SessionAttachment)),
    sendInput: vi.fn((sessionId: number, data: string | Uint8Array) => {
      writes.push([sessionId, data]);
      return true;
    }),
    onError: () => () => undefined,
    close: vi.fn(),
  };

  const dirExists = vi.fn(options.dirExists ?? (async () => true));
  const touchDaemonSession = vi.fn();
  let nextTabId = 1;
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.layout ?? emptyLayout()),
    persistence,
    attachments,
    sessions: options.sessions ?? [],
    generateId: () => `saved-tab-${nextTabId++}`,
    settings: { getSnapshot: () => ({ ...DEFAULT_SETTINGS, ...options.settings }) },
    dirExists,
    savedSessions: { touchDaemonSession },
  });

  return {
    controller,
    createSession,
    createdCwds,
    createdSessionIds,
    dirExists,
    probeSession,
    touchDaemonSession,
    writes,
    notice: () => controller.getSnapshot().notice,
    activeTabId: () => controller.getSnapshot().activeTabId,
    tabCount: () => controller.getSnapshot().ungroupedTabs.length,
    tabIds: () => controller.getSnapshot().ungroupedTabs.map((tab) => tab.id),
    emitExit(sessionId: number) {
      for (const listener of exitListeners) {
        listener({ sessionId, exitCode: 1 });
      }
    },
  };
}

/** Drive a fresh restore through its prompt-ready report. */
async function resumeAndSettle(
  h: ReturnType<typeof harness>,
  entry: SavedSession,
): Promise<void> {
  const done = h.controller.resumeSaved(entry);
  await settleMicrotasks();
  const sessionId = h.createdSessionIds.at(-1);
  if (sessionId !== undefined) {
    h.controller.reportSessionCwd(sessionId, entry.cwd, true);
  }
  return done;
}

/**
 * The probe verdicts (adversarial triage P0 #1). The old reattach treated
 * "shell still alive" as "conversation still there" and delivered a silent
 * empty pane whenever claude had exited. With the daemon's busy probe the
 * controller now tells the two apart — and every path that cannot KNOW the
 * shell is idle must reattach and type nothing.
 */
describe("WorkspaceController.resumeSaved probe verdicts", () => {
  it("reattaches untouched when the probe says the shell is busy", async () => {
    const h = harness({
      sessions: [session(7)],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: true },
    });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.activeTabId()).toBe("existing-tab");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBeNull();
  });

  it("types the resume command into an idle shell standing in the saved folder", async () => {
    const h = harness({
      sessions: [session(7)],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: false },
    });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.activeTabId()).toBe("existing-tab");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.writes).toEqual([[7, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(h.notice()).toBeNull();
  });

  it("compares folders case- and slash-blind before typing in place", async () => {
    const h = harness({
      sessions: [session(7, { cwd: "c:/dev/termx/" })],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: false },
    });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.writes).toEqual([[7, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("restores fresh when the idle shell has wandered out of the saved folder", async () => {
    const h = harness({
      sessions: [session(7, { cwd: "C:\\Users\\mjfos" })],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: false },
    });
    const entry = saved({ lastDaemonSessionId: 7 });

    await resumeAndSettle(h, entry);

    // A NEW shell in the saved folder gets the command; the wandered shell is
    // left exactly as it stands.
    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-1", 50);
  });

  it("restores fresh when the shell's folder was never reported", async () => {
    const h = harness({
      sessions: [session(7, { cwd: null })],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: false },
    });
    const entry = saved({ lastDaemonSessionId: 7 });

    await resumeAndSettle(h, entry);

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("reattaches untouched when the probe itself fails", async () => {
    const h = harness({
      sessions: [session(7)],
      layout: layoutWithTab("existing-tab", 7),
      probe: "reject",
    });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.activeTabId()).toBe("existing-tab");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("restores fresh when the probe reports the session died mid-click", async () => {
    const h = harness({
      sessions: [session(7)],
      probe: { alive: false, busy: false },
    });
    const entry = saved({ lastDaemonSessionId: 7 });

    await resumeAndSettle(h, entry);

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("never probes a bare-shell save — the shell IS the thing that was saved", async () => {
    const h = harness({
      sessions: [session(7)],
      layout: layoutWithTab("existing-tab", 7),
      probe: { alive: true, busy: false },
    });

    await h.controller.resumeSaved(
      saved({ lastDaemonSessionId: 7, conversation: undefined }),
    );

    expect(h.probeSession).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.activeTabId()).toBe("existing-tab");
  });
});

describe("WorkspaceController.resumeSaved reattach", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // No `probe` option: this harness models an OLDER daemon, whose client has
  // no probeSession — the verdict must fall back to reattach-and-type-nothing.
  it("activates the tab that already holds the live daemon session, creating nothing", async () => {
    const h = harness({
      sessions: [session(7)],
      layout: layoutWithTab("existing-tab", 7),
    });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.activeTabId()).toBe("existing-tab");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.dirExists).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBeNull();
  });

  it("opens a tab onto a live but tabless session without creating a shell", async () => {
    const h = harness({ sessions: [session(7)] });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(1);
    expect(h.controller.getSnapshot().ungroupedTabs[0]?.primarySessionId).toBe(7);
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBeNull();
  });

  it("leaves the recorded daemon session untouched when the reattach changes nothing", async () => {
    const h = harness({ sessions: [session(7)] });

    await h.controller.resumeSaved(saved({ lastDaemonSessionId: 7 }));

    expect(h.touchDaemonSession).not.toHaveBeenCalled();
  });

  it("falls through to a fresh restore when the recorded session is dead", async () => {
    const h = harness({ sessions: [session(7, { alive: false })] });
    const entry = saved({ lastDaemonSessionId: 7 });

    await resumeAndSettle(h, entry);

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-1", 50);
  });

  it("falls through to a fresh restore when the host never knew the session", async () => {
    const h = harness();

    await resumeAndSettle(h, saved({ lastDaemonSessionId: 999 }));

    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });
});

describe("WorkspaceController.resumeSaved fresh restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the shell in the saved folder and types the resume command on prompt-ready", async () => {
    const h = harness();
    const entry = saved();

    const done = h.controller.resumeSaved(entry);
    await settleMicrotasks();
    expect(h.writes).toEqual([]);

    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(h.tabCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBeNull();
  });

  it("never falls back to the host default directory", async () => {
    const h = harness({
      createSession: async (cwd) => {
        if (cwd === null) {
          throw new Error("the default dir must never be tried");
        }
        throw new Error("host refused");
      },
    });

    await h.controller.resumeSaved(saved());

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.notice()).toBe("The terminal session could not be created.");
    expect(h.tabCount()).toBe(0);
  });

  it("records the created daemon session and the resume key for chat linkage", async () => {
    const h = harness();

    await resumeAndSettle(h, saved());

    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-1", 50);
    const tabId = h.tabIds()[0]!;
    expect(h.controller.resumedSessionKeyForTab(tabId)).toBe(`claude:${CLAUDE_ID}`);
  });

  it("types the codex verb for a codex conversation", async () => {
    const h = harness();

    await resumeAndSettle(
      h,
      saved({ conversation: { provider: "codex", id: "abc-123", title: "Thread" } }),
    );

    expect(h.writes).toEqual([[50, "codex resume abc-123\r"]]);
  });

  it("types nothing for a bare-shell save, but still opens the folder and records the session", async () => {
    const h = harness();
    const entry = saved({ conversation: undefined });

    await h.controller.resumeSaved(entry);

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.tabCount()).toBe(1);
    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-1", 50);
    const tabId = h.tabIds()[0]!;
    expect(h.controller.resumedSessionKeyForTab(tabId)).toBeNull();
    expect(h.notice()).toBeNull();
  });

  it("sends anyway when the prompt never reports within 15 s", async () => {
    const h = harness();

    const done = h.controller.resumeSaved(saved());
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RESUME_PROMPT_TIMEOUT_MS - 1);
    expect(h.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("sends nothing when the terminal dies before the prompt arrives", async () => {
    const h = harness();

    const done = h.controller.resumeSaved(saved());
    await settleMicrotasks();
    h.emitExit(50);
    await done;

    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBe("The terminal ended before the session could be resumed.");
  });
});

describe("WorkspaceController.resumeSaved refusals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a vanished folder by name, without creating a terminal", async () => {
    const h = harness({ dirExists: async () => false });

    await h.controller.resumeSaved(saved({ cwd: "D:\\gone\\project" }));

    expect(h.dirExists).toHaveBeenCalledWith("D:\\gone\\project");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(0);
    expect(h.notice()).toBe(
      "The saved session's folder no longer exists (D:\\gone\\project).",
    );
  });

  it("refuses a bare-shell save whose folder is gone", async () => {
    const h = harness({ dirExists: async () => false });

    await h.controller.resumeSaved(saved({ conversation: undefined }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe(
      "The saved session's folder no longer exists (C:\\Dev\\TermX).",
    );
  });

  it("treats a probe that throws as a vanished folder", async () => {
    const h = harness({
      dirExists: async () => {
        throw new Error("ipc down");
      },
    });

    await h.controller.resumeSaved(saved());

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe(
      "The saved session's folder no longer exists (C:\\Dev\\TermX).",
    );
  });

  it("refuses an id that is not a bare token before probing the disk", async () => {
    const h = harness();

    await h.controller.resumeSaved(
      saved({
        conversation: { provider: "claude", id: "../evil; calc", title: "Hostile" },
      }),
    );

    expect(h.dirExists).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.touchDaemonSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe("That session cannot be resumed: its id is not valid.");
  });

  it("refuses an unknown provider the same way", async () => {
    const h = harness();

    await h.controller.resumeSaved(
      saved({
        conversation: {
          // A corrupt store row could name any provider; the command builder
          // is the only thing standing between it and a terminal.
          provider: "grok" as unknown as SavedProvider,
          id: CLAUDE_ID,
          title: "Unknown",
        },
      }),
    );

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe("That session cannot be resumed: its id is not valid.");
  });
});

/**
 * What a resume hands the chat (auto-reveal spec §4): which tab and session it
 * created, WHEN it happened (so a transcript written afterwards can be
 * recognised as the successor), and a boot signal the pane can open its dock
 * on. Same map that already deduped resumes — it just carries more now.
 */
const RESUMED_AT = 1_700_000_000_000;

function conversation(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: CLAUDE_ID,
    title: "Daemon work",
    cwd: "C:\\Dev\\TermX",
    filePath: `C:\\Users\\me\\.claude\\projects\\C--Dev-TermX\\${CLAUDE_ID}.jsonl`,
    updatedAtMs: 1000,
    summary: null,
    recap: null,
    ...overrides,
  };
}

/** Drive `resumeSession` through its prompt-ready report. */
async function resumeSessionAndSettle(h: ReturnType<typeof harness>) {
  const done = h.controller.resumeSession(conversation());
  await settleMicrotasks();
  const sessionId = h.createdSessionIds.at(-1);
  if (sessionId !== undefined) {
    h.controller.reportSessionCwd(sessionId, "C:\\Dev\\TermX", true);
  }
  return done;
}

describe("WorkspaceController resume bindings (auto-reveal spec §4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RESUMED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the tab and session it created in the outcome", async () => {
    const h = harness();

    const outcome = await resumeSessionAndSettle(h);

    expect(outcome).toEqual({
      kind: "opened",
      tabId: h.tabIds()[0],
      sessionId: 50,
    });
  });

  it("stamps every resumed tab with the moment of the resume", async () => {
    const h = harness();

    await resumeSessionAndSettle(h);

    expect(h.controller.resumedEntries()).toEqual([
      { key: `claude:${CLAUDE_ID}`, tabId: h.tabIds()[0], resumedAtMs: RESUMED_AT },
    ]);
  });

  it("stamps a fresh restore of a saved session too", async () => {
    const h = harness();

    await resumeAndSettle(h, saved());

    expect(h.controller.resumedEntries()).toEqual([
      { key: `claude:${CLAUDE_ID}`, tabId: h.tabIds()[0], resumedAtMs: RESUMED_AT },
    ]);
  });

  it("forgets a resumed tab once its pane dies", async () => {
    const h = harness();
    await resumeSessionAndSettle(h);

    h.emitExit(50);

    expect(h.controller.resumedEntries()).toEqual([]);
    expect(h.controller.resumedSessionKeyForTab(h.tabIds()[0]!)).toBeNull();
  });

  it("rebinds a tab to the transcript the resume handed off to", async () => {
    const h = harness();
    await resumeSessionAndSettle(h);
    const tabId = h.tabIds()[0]!;

    h.controller.rebindResumedTab(`claude:${CLAUDE_ID}`, "claude:successor");

    expect(h.controller.resumedEntries()).toEqual([
      { key: "claude:successor", tabId, resumedAtMs: RESUMED_AT },
    ]);
    // The pane now answers with the successor, so the feed tails the new file.
    expect(h.controller.resumedSessionKeyForTab(tabId)).toBe("claude:successor");
  });

  it("ignores a rebind of a key it never resumed, and a rebind onto itself", async () => {
    const h = harness();
    await resumeSessionAndSettle(h);
    const before = h.controller.resumedEntries();

    h.controller.rebindResumedTab("claude:never-resumed", "claude:successor");
    h.controller.rebindResumedTab(`claude:${CLAUDE_ID}`, `claude:${CLAUDE_ID}`);

    expect(h.controller.resumedEntries()).toEqual(before);
  });

  it("refuses a rebind onto a key another tab already owns", async () => {
    // Two resumes in one folder can nominate the same successor; adopting it
    // twice would clobber the first tab's binding.
    const h = harness();
    await resumeSessionAndSettle(h);
    const other = h.controller.resumeSession(
      conversation({ id: "11111111-2222-4333-8444-555566667777" }),
    );
    await settleMicrotasks();
    const sessionId = h.createdSessionIds.at(-1);
    if (sessionId !== undefined) {
      h.controller.reportSessionCwd(sessionId, "C:\\Dev\\TermX", true);
    }
    await other;
    const before = h.controller.resumedEntries();
    expect(before).toHaveLength(2);

    h.controller.rebindResumedTab(
      `claude:${CLAUDE_ID}`,
      "claude:11111111-2222-4333-8444-555566667777",
    );

    expect(h.controller.resumedEntries()).toEqual(before);
  });

  it("announces the booting session to the resume boot listener", async () => {
    const h = harness();
    const booted: number[] = [];
    h.controller.setResumeBootListener((sessionId) => booted.push(sessionId));

    await resumeSessionAndSettle(h);

    expect(booted).toEqual([50]);
  });

  it("announces a saved fresh restore that carries a conversation", async () => {
    const h = harness();
    const booted: number[] = [];
    h.controller.setResumeBootListener((sessionId) => booted.push(sessionId));

    await resumeAndSettle(h, saved());

    expect(booted).toEqual([50]);
  });

  it("stays silent for a bare-shell restore and for a refused resume", async () => {
    const h = harness({ dirExists: async () => false });
    const booted: number[] = [];
    h.controller.setResumeBootListener((sessionId) => booted.push(sessionId));

    // A vanished folder never opens a tab, so there is no boot to watch.
    await h.controller.resumeSession(conversation());
    expect(booted).toEqual([]);

    const bare = harness();
    bare.controller.setResumeBootListener((sessionId) => booted.push(sessionId));
    await bare.controller.resumeSaved(saved({ conversation: undefined }));
    // Nothing was typed into that shell: there is no agent booting in it.
    expect(booted).toEqual([]);
  });

  it("survives having no boot listener at all", async () => {
    const h = harness();
    h.controller.setResumeBootListener(null);

    await expect(resumeSessionAndSettle(h)).resolves.toMatchObject({
      kind: "opened",
    });
  });
});
