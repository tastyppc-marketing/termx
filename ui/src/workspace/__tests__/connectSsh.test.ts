/**
 * `WorkspaceController.connectSshHost` (ssh-sessions spec §2).
 *
 * One click has to do what Michael would otherwise type: open a local shell,
 * wait for its prompt, then send the ssh connect command that carries the whole
 * remote bootstrap with it. It is the resume machinery, reused — which is the
 * point: that path is already proven against a shell that answers slowly.
 *
 * The pane is then REMEMBERED as an ssh pane (that is what makes it pin-able as
 * a remote save later), and the conversation ids the remote watcher reports are
 * kept per pane, newest wins.
 *
 * A stored password is typed by a bounded watcher over the pane's live output.
 * The tests here prove it is typed ONCE, only on a real prompt, and that the
 * watcher lets go afterwards — a watcher that outlived its window would be
 * something that types a password into whatever came later.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAttachment } from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { emptyLayout, type LayoutV2 } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { sshConnectCommand } from "../../ssh/bootstrap";
import type { SshHost } from "../../ssh/types";
import { UiStateStore, type UiStateV1 } from "../uiState";
import {
  SSH_PASSWORD_WATCH_MS,
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../WorkspaceController";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";

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

/** Yield long enough for every awaited step of a connect to settle. */
async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

function harness(options: {
  settings?: Partial<TermxSettings>;
  sessions?: readonly SessionInfo[];
  layout?: LayoutV2;
  uiState?: UiStateV1;
  passwords?: Record<string, string>;
  passwordsThrow?: boolean;
  withoutTap?: boolean;
} = {}) {
  const exitListeners = new Set<
    (event: { sessionId: number; exitCode: number | null }) => void
  >();
  const closedListeners = new Set<(event: { sessionId: number }) => void>();
  const createdCwds: Array<string | null> = [];
  const createdSessionIds: number[] = [];
  const writes: Array<[number, string | Uint8Array]> = [];
  const taps = new Map<number, Set<(text: string) => void>>();
  let disposedTaps = 0;
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
    onSessionClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
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
    ...(options.withoutTap
      ? {}
      : {
          tapOutput: vi.fn(
            (sessionId: number, listener: (text: string) => void) => {
              const set = taps.get(sessionId) ?? new Set();
              set.add(listener);
              taps.set(sessionId, set);
              return {
                dispose: () => {
                  disposedTaps += 1;
                  taps.get(sessionId)?.delete(listener);
                },
              };
            },
          ),
        }),
    onError: () => () => undefined,
    close: vi.fn(),
  };

  const passwordFor = vi.fn(async (alias: string) => {
    if (options.passwordsThrow) {
      throw new Error("credentials store is unavailable");
    }
    return options.passwords?.[alias] ?? null;
  });

  const uiState = new UiStateStore(
    options.uiState ? { initial: options.uiState } : {},
  );
  let nextTabId = 1;
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(options.layout ?? emptyLayout()),
    persistence,
    attachments,
    sessions: options.sessions ?? [],
    generateId: () => `ssh-tab-${nextTabId++}`,
    settings: { getSnapshot: () => ({ ...DEFAULT_SETTINGS, ...options.settings }) },
    uiState,
    sshPasswords: { passwordFor },
  });

  return {
    controller,
    uiState,
    createSession,
    createdCwds,
    createdSessionIds,
    passwordFor,
    writes,
    tapCount: () => [...taps.values()].reduce((sum, set) => sum + set.size, 0),
    disposedTaps: () => disposedTaps,
    notice: () => controller.getSnapshot().notice,
    tabCount: () => controller.getSnapshot().ungroupedTabs.length,
    groupTabCount: (groupId: string) =>
      controller.getSnapshot().groups.find((group) => group.id === groupId)?.tabs
        .length ?? 0,
    sshPanes: () => uiState.getSnapshot().sshPanes,
    emitOutput(sessionId: number, text: string) {
      for (const listener of [...(taps.get(sessionId) ?? [])]) {
        listener(text);
      }
    },
    emitExit(sessionId: number) {
      for (const listener of [...exitListeners]) {
        listener({ sessionId, exitCode: 1 });
      }
    },
    emitClosed(sessionId: number) {
      for (const listener of [...closedListeners]) {
        listener({ sessionId });
      }
    },
  };
}

/** Drive a connect through its local prompt-ready report. */
async function connectAndSettle(
  h: ReturnType<typeof harness>,
  target: SshHost = host(),
  opts?: { groupId?: string | null },
): Promise<void> {
  const done = h.controller.connectSshHost(target, opts);
  await settleMicrotasks();
  const sessionId = h.createdSessionIds.at(-1);
  if (sessionId !== undefined) {
    h.controller.reportSessionCwd(sessionId, "C:\\Dev\\TermX", true);
  }
  await done;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceController.connectSshHost", () => {
  it("opens a local shell and types the connect command once its prompt reports", async () => {
    const h = harness();

    const done = h.controller.connectSshHost(host());
    await settleMicrotasks();
    // The connect command must not race the shell's first prompt.
    expect(h.writes).toEqual([]);
    expect(h.tabCount()).toBe(1);

    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;

    expect(h.createdCwds).toEqual([null]);
    expect(h.writes).toEqual([[50, `${sshConnectCommand("myvps")}\r`]]);
    expect(h.controller.sshPaneInfo(50)).toEqual({ host: "myvps" });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBeNull();
  });

  it("records the ssh pane in ui state so a restart still knows what it is", async () => {
    const h = harness();

    await connectAndSettle(h);

    expect(h.sshPanes()).toEqual({ "50": { host: "myvps" } });
  });

  it("connects into a group when one is named", async () => {
    const layout = emptyLayout();
    layout.groups["vpses"] = {
      id: "vpses",
      name: "VPSes",
      collapsed: false,
      color: null,
      items: [],
    };
    layout.rootItems = [{ kind: "group", id: "vpses" }];
    const h = harness({ layout });

    await connectAndSettle(h, host(), { groupId: "vpses" });

    expect(h.groupTabCount("vpses")).toBe(1);
    expect(h.tabCount()).toBe(0);
  });

  it("refuses an alias that is not a plain name, before creating anything", async () => {
    const h = harness();

    await h.controller.connectSshHost(host({ alias: "evil; calc" }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBe(
      "That SSH host cannot be connected: its alias is not a plain name.",
    );
  });

  it("reports a shell that could not be created", async () => {
    const h = harness();
    h.createSession.mockRejectedValue(new Error("host refused"));

    await h.controller.connectSshHost(host());

    expect(h.tabCount()).toBe(0);
    expect(h.notice()).toBe("The terminal session could not be created.");
  });
});

describe("WorkspaceController ssh conversation captures", () => {
  it("keeps the newest capture per pane and mirrors it into ui state", async () => {
    const h = harness();
    await connectAndSettle(h);

    h.controller.reportCapturedConversation(50, { provider: "claude", id: "first" });
    expect(h.controller.capturedConversation(50)).toEqual({
      provider: "claude",
      id: "first",
    });

    h.controller.reportCapturedConversation(50, { provider: "claude", id: CLAUDE_ID });

    expect(h.controller.capturedConversation(50)).toEqual({
      provider: "claude",
      id: CLAUDE_ID,
    });
    expect(h.sshPanes()).toEqual({
      "50": { host: "myvps", capturedProvider: "claude", capturedId: CLAUDE_ID },
    });
  });

  it("ignores a capture from a pane that is not a tracked ssh pane", async () => {
    const h = harness();

    h.controller.reportCapturedConversation(77, { provider: "claude", id: CLAUDE_ID });

    expect(h.controller.capturedConversation(77)).toBeNull();
    expect(h.sshPanes()).toBeUndefined();
  });

  it("forgets a pane the host has closed", async () => {
    const h = harness();
    await connectAndSettle(h);
    h.controller.reportCapturedConversation(50, { provider: "codex", id: "abc-1" });

    h.emitClosed(50);

    expect(h.controller.sshPaneInfo(50)).toBeNull();
    expect(h.controller.capturedConversation(50)).toBeNull();
    expect(h.sshPanes()).toBeUndefined();
  });
});

describe("WorkspaceController ssh password watcher", () => {
  const PROMPT = "root@10.0.0.1's password: ";

  it("types the stored password once, on the prompt, then lets go", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);
    expect(h.tapCount()).toBe(1);

    h.emitOutput(50, PROMPT);

    expect(h.writes).toEqual([
      [50, `${sshConnectCommand("myvps")}\r`],
      [50, "not-a-real-password\r"],
    ]);
    expect(h.tapCount()).toBe(0);
    expect(h.disposedTaps()).toBe(1);

    // A second prompt (a wrong password, a second host) is not this watcher's
    // business: one connect types one password.
    h.emitOutput(50, PROMPT);
    expect(h.writes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the watcher go once the remote shell reports its prompt", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);
    expect(h.tapCount()).toBe(1);

    // A rooted Unix cwd is the remote shell's own prompt: login succeeded, so
    // no password will be asked again and the watcher must let go now — before
    // its window can catch an unrelated later prompt.
    h.controller.reportSessionCwd(50, "/root", true);
    expect(h.tapCount()).toBe(0);
    expect(h.disposedTaps()).toBe(1);

    // The classic misfire: a `sudo` prompt after login must NOT be answered
    // with the ssh password.
    h.emitOutput(50, "[sudo] password for root: ");
    expect(h.writes).toEqual([[50, `${sshConnectCommand("myvps")}\r`]]);
  });

  it("matches a prompt split across two output frames", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);

    h.emitOutput(50, "root@10.0.0.1's pass");
    expect(h.writes).toHaveLength(1);
    h.emitOutput(50, "word: ");

    expect(h.writes[1]).toEqual([50, "not-a-real-password\r"]);
  });

  it("stays quiet for ordinary remote output", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);

    h.emitOutput(50, "Last login: Sun Aug 17 09:00:00 2026 from 10.0.0.9\r\n");
    h.emitOutput(50, "root@vps:~# cat password:\r\n");
    h.emitOutput(50, "root@vps:~# ");

    expect(h.writes).toHaveLength(1);
    expect(h.tapCount()).toBe(1);
  });

  it("watches nothing when no password is stored for the host", async () => {
    const h = harness();
    await connectAndSettle(h);

    expect(h.passwordFor).toHaveBeenCalledWith("myvps");
    expect(h.tapCount()).toBe(0);
    h.emitOutput(50, PROMPT);
    expect(h.writes).toHaveLength(1);
  });

  it("treats a credentials store that throws as no stored password", async () => {
    const h = harness({ passwordsThrow: true });

    await connectAndSettle(h);

    expect(h.tapCount()).toBe(0);
    expect(h.writes).toEqual([[50, `${sshConnectCommand("myvps")}\r`]]);
    expect(h.notice()).toBeNull();
  });

  it("gives up after the watch window and types nothing afterwards", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);

    await vi.advanceTimersByTimeAsync(SSH_PASSWORD_WATCH_MS);
    expect(h.tapCount()).toBe(0);

    h.emitOutput(50, PROMPT);
    expect(h.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the watcher when the terminal dies mid-connect", async () => {
    const h = harness({ passwords: { myvps: "not-a-real-password" } });
    await connectAndSettle(h);

    h.emitExit(50);

    expect(h.tapCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("connects normally against a hub that offers no output tap", async () => {
    const h = harness({
      passwords: { myvps: "not-a-real-password" },
      withoutTap: true,
    });

    await connectAndSettle(h);

    expect(h.writes).toEqual([[50, `${sshConnectCommand("myvps")}\r`]]);
    expect(h.notice()).toBeNull();
  });
});

describe("WorkspaceController ssh pane hydration", () => {
  it("restores panes for sessions the host still has, dropping the rest", async () => {
    const h = harness({
      sessions: [session(7)],
      uiState: {
        scopePaths: { seeds: {}, active: {} },
        recentFolders: [],
        sshPanes: {
          "7": { host: "myvps", capturedProvider: "claude", capturedId: CLAUDE_ID },
          "9": { host: "gone" },
        },
      },
    });

    expect(h.controller.sshPaneInfo(7)).toEqual({ host: "myvps" });
    expect(h.controller.capturedConversation(7)).toEqual({
      provider: "claude",
      id: CLAUDE_ID,
    });
    expect(h.controller.sshPaneInfo(9)).toBeNull();
    // The stale entry is not just ignored: it is swept out of the file, so it
    // can never collide with a future session that reuses the id.
    expect(h.sshPanes()).toEqual({
      "7": { host: "myvps", capturedProvider: "claude", capturedId: CLAUDE_ID },
    });
  });
});
