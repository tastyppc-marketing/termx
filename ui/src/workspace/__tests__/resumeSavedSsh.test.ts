/**
 * Resuming a saved SSH session (ssh-sessions spec §5).
 *
 * The point of the whole batch: "as if he never left". A restore has to SSH
 * back in, land in the remote folder, and resume the exact remote conversation
 * — which means TWO waits, not one. The first is the LOCAL shell's prompt (the
 * point at which the connect command can be typed); the second is the REMOTE
 * shell's first prompt, which only its own cwd report can prove.
 *
 * The tests below are mostly about that second wait, because getting it wrong
 * means typing `claude --resume` into Windows powershell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { emptyLayout, type LayoutV2 } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import type { DirExists } from "../../conversations/resume";
import { RESUME_PROMPT_TIMEOUT_MS } from "../../conversations/resume";
import type { SavedProvider, SavedSession } from "../../saved/types";
import { sshConnectCommand } from "../../ssh/bootstrap";
import type { SshHost } from "../../ssh/types";
import {
  SSH_REMOTE_PROMPT_TIMEOUT_MS,
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";
const REMOTE_CWD = "/root/projects/app";

function host(overrides: Partial<SshHost> = {}): SshHost {
  return {
    alias: "myvps",
    aliases: ["myvps"],
    hostName: "10.0.0.1",
    user: "root",
    identityFile: null,
    ...overrides,
  };
}

function savedSsh(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: "saved-ssh-1",
    name: "VPS deploy work",
    cwd: REMOTE_CWD,
    conversation: { provider: "claude", id: CLAUDE_ID, title: "Deploy work" },
    ssh: { host: "myvps" },
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  };
}

function session(id: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    profile: "powershell",
    cwd: null,
    cols: 120,
    rows: 30,
    alive: true,
    pid: 4000 + id,
    ...overrides,
  };
}

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
  hosts?: readonly SshHost[] | null;
  passwords?: Record<string, string>;
} = {}) {
  const exitListeners = new Set<
    (event: { sessionId: number; exitCode: number | null }) => void
  >();
  const createdCwds: Array<string | null> = [];
  const createdSessionIds: number[] = [];
  const writes: Array<[number, string | Uint8Array]> = [];
  const taps = new Map<number, Set<(text: string) => void>>();
  let nextSessionId = 50;

  const createSession = vi.fn(
    async (createOptions: {
      profile: string | null;
      cwd: string | null;
      cols: number;
      rows: number;
    }): Promise<SessionInfo> => {
      createdCwds.push(createOptions.cwd);
      const created = session(nextSessionId++, {
        profile: createOptions.profile ?? "powershell",
        cwd: createOptions.cwd,
        cols: createOptions.cols,
        rows: createOptions.rows,
      });
      createdSessionIds.push(created.id);
      return created;
    },
  );

  const client: WorkspaceHostClient = {
    createSession,
    closeSession: vi.fn(async () => undefined),
    onSessionExited(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
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
    tapOutput: vi.fn((sessionId: number, listener: (text: string) => void) => {
      const set = taps.get(sessionId) ?? new Set();
      set.add(listener);
      taps.set(sessionId, set);
      return { dispose: () => void taps.get(sessionId)?.delete(listener) };
    }),
    onError: () => () => undefined,
    close: vi.fn(),
  };

  const hosts = options.hosts === undefined ? [host()] : options.hosts;
  const byAlias = vi.fn(
    (alias: string) => hosts?.find((entry) => entry.alias === alias) ?? null,
  );
  const dirExists = vi.fn(options.dirExists ?? (async () => true));
  const touchDaemonSession = vi.fn();
  let nextTabId = 1;
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.layout ?? emptyLayout()),
    persistence,
    attachments,
    sessions: options.sessions ?? [],
    generateId: () => `ssh-tab-${nextTabId++}`,
    settings: { getSnapshot: () => ({ ...DEFAULT_SETTINGS, ...options.settings }) },
    dirExists,
    savedSessions: { touchDaemonSession },
    ...(hosts === null ? {} : { sshHosts: { byAlias } }),
    sshPasswords: {
      passwordFor: async (alias) => options.passwords?.[alias] ?? null,
    },
  });

  return {
    controller,
    byAlias,
    createSession,
    createdCwds,
    createdSessionIds,
    dirExists,
    touchDaemonSession,
    writes,
    tapCount: () => [...taps.values()].reduce((sum, set) => sum + set.size, 0),
    notice: () => controller.getSnapshot().notice,
    activeTabId: () => controller.getSnapshot().activeTabId,
    tabCount: () => controller.getSnapshot().ungroupedTabs.length,
    tabIds: () => controller.getSnapshot().ungroupedTabs.map((tab) => tab.id),
    emitExit(sessionId: number) {
      for (const listener of [...exitListeners]) {
        listener({ sessionId, exitCode: 1 });
      }
    },
  };
}

const CONNECT = `${sshConnectCommand("myvps", { remoteCwd: REMOTE_CWD })}\r`;

/**
 * Drive an ssh restore up to (not through) the remote shell's first prompt.
 * The in-flight resume is handed back wrapped, because an async function that
 * RETURNS a promise would await it — and this one is deliberately unfinished.
 */
async function restoreToRemotePrompt(
  h: ReturnType<typeof harness>,
  entry: SavedSession,
): Promise<{ done: Promise<void> }> {
  const done = h.controller.resumeSaved(entry);
  await settleMicrotasks();
  h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
  await settleMicrotasks();
  return { done };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceController.resumeSaved over ssh", () => {
  it("connects, then resumes only once the REMOTE shell reports its prompt", async () => {
    const h = harness();

    const done = h.controller.resumeSaved(savedSsh());
    await settleMicrotasks();
    expect(h.writes).toEqual([]);

    // The local shell's prompt: this types the connect command, nothing else.
    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await settleMicrotasks();
    expect(h.writes).toEqual([[50, CONNECT]]);

    // A SECOND local report must not be mistaken for the remote shell.
    h.controller.reportSessionCwd(50, "C:\\Users\\mjfos", true);
    await settleMicrotasks();
    expect(h.writes).toEqual([[50, CONNECT]]);

    // The remote shell's own cwd report — a rooted Unix path — is the signal.
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    expect(h.writes).toEqual([
      [50, CONNECT],
      [50, `claude --resume ${CLAUDE_ID}\r`],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBeNull();
  });

  it("creates the local shell with no folder and never probes the remote one", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    // The saved cwd is REMOTE: probing it locally would refuse every ssh save
    // on a machine that happens not to have a `/root/projects/app`.
    expect(h.dirExists).not.toHaveBeenCalled();
    expect(h.createdCwds).toEqual([null]);
  });

  it("records the daemon session, the resume key and the ssh pane", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-ssh-1", 50);
    expect(h.controller.resumedSessionKeyForTab(h.tabIds()[0]!)).toBe(
      `claude:${CLAUDE_ID}`,
    );
    // Pin-able again straight away: the restored pane is a tracked ssh pane.
    expect(h.controller.sshPaneInfo(50)).toEqual({ host: "myvps" });
  });

  it("types only the connect command for a bare remote shell", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(
      h,
      savedSsh({ conversation: undefined }),
    );
    await done;

    expect(h.writes).toEqual([[50, CONNECT]]);
    expect(h.touchDaemonSession).toHaveBeenCalledWith("saved-ssh-1", 50);
    // Nothing is waiting for a remote prompt it has no use for.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("types the codex verb for a codex conversation", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(
      h,
      savedSsh({
        conversation: { provider: "codex", id: "abc-123", title: "Thread" },
      }),
    );
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    expect(h.writes[1]).toEqual([50, "codex resume abc-123\r"]);
  });

  it("says so when the remote prompt never reports, rather than silently doing nothing", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    await vi.advanceTimersByTimeAsync(SSH_REMOTE_PROMPT_TIMEOUT_MS);
    await done;

    // The shell is up but no prompt was seen (slow box, or a bashrc that eats
    // the OSC), so nothing on screen explains why the resume never ran — unlike
    // a dead connection, the timeout needs a word. The resume command is still
    // NOT typed blind into whatever state the shell is in.
    expect(h.writes).toEqual([[50, CONNECT]]);
    expect(h.notice()).toBe(
      "Connected, but the remote prompt was not detected — run the resume command yourself.",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("types nothing more when the terminal dies mid-connection", async () => {
    const h = harness();

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    h.emitExit(50);
    await done;

    expect(h.writes).toEqual([[50, CONNECT]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms the password watcher for a host with a stored password", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    expect(h.tapCount()).toBe(1);
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;
  });

  it("still restores when no host inventory was supplied", async () => {
    const h = harness({ hosts: null });

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    expect(h.writes).toEqual([
      [50, CONNECT],
      [50, `claude --resume ${CLAUDE_ID}\r`],
    ]);
  });
});

describe("WorkspaceController.resumeSaved over ssh refusals", () => {
  it("refuses a host that has left the ssh config, by name", async () => {
    const h = harness({ hosts: [host({ alias: "othervps" })] });

    await h.controller.resumeSaved(savedSsh());

    expect(h.byAlias).toHaveBeenCalledWith("myvps");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.touchDaemonSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe("Host myvps is no longer in your SSH config.");
  });

  it("refuses an alias that is not a plain name", async () => {
    const h = harness({ hosts: [host({ alias: "evil; calc" })] });

    await h.controller.resumeSaved(savedSsh({ ssh: { host: "evil; calc" } }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe(
      "That SSH host cannot be connected: its alias is not a plain name.",
    );
  });

  it("refuses a conversation id that is not a bare token, before connecting", async () => {
    const h = harness();

    await h.controller.resumeSaved(
      savedSsh({
        conversation: { provider: "claude", id: "../evil; calc", title: "x" },
      }),
    );

    expect(h.byAlias).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe("That session cannot be resumed: its id is not valid.");
  });

  it("refuses an unknown provider the same way", async () => {
    const h = harness();

    await h.controller.resumeSaved(
      savedSsh({
        conversation: {
          provider: "grok" as unknown as SavedProvider,
          id: CLAUDE_ID,
          title: "x",
        },
      }),
    );

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe("That session cannot be resumed: its id is not valid.");
  });

  it("reattaches to a live daemon session without connecting again", async () => {
    const h = harness({
      sessions: [session(7, { cwd: REMOTE_CWD })],
      layout: layoutWithTab("existing-tab", 7),
    });

    await h.controller.resumeSaved(savedSsh({ lastDaemonSessionId: 7 }));

    expect(h.activeTabId()).toBe("existing-tab");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.byAlias).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBeNull();
  });

  it("reports a local shell that could not be created", async () => {
    const h = harness();
    h.createSession.mockRejectedValue(new Error("host refused"));

    await h.controller.resumeSaved(savedSsh());

    expect(h.tabCount()).toBe(0);
    expect(h.notice()).toBe("The terminal session could not be created.");
  });

  it("announces the remote boot only once the resume command is really typed", async () => {
    const h = harness();
    const booted: number[] = [];
    h.controller.setResumeBootListener((sessionId) => booted.push(sessionId));

    const { done } = await restoreToRemotePrompt(h, savedSsh());
    // Connected, but the remote prompt has not reported: nothing has been
    // resumed yet, so there is no boot to announce.
    expect(booted).toEqual([]);

    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;

    expect(booted).toEqual([50]);
  });

  it("waits for the local prompt only as long as a local resume would", async () => {
    const h = harness();

    const done = h.controller.resumeSaved(savedSsh());
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RESUME_PROMPT_TIMEOUT_MS - 1);
    expect(h.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await settleMicrotasks();
    expect(h.writes).toEqual([[50, CONNECT]]);
    h.controller.reportSessionCwd(50, REMOTE_CWD, true);
    await done;
  });
});
