/**
 * Resume flow (spec §5): command construction, target validation, the
 * prompt-ready wait, and the input injection.
 *
 * The AttachmentHub seam this flow types through is exercised here too (its
 * only consumer is the resume flow, so its proof lives with it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionAttachment,
  SessionAttachmentCallbacks,
} from "../../host/client";
import type { SessionInfo } from "../../host/protocol";
import { emptyLayout } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { DEFAULT_SETTINGS, type TermxSettings } from "../../settings/settings";
import { AttachmentHub, type AttachmentHostClient } from "../../workspace/AttachmentHub";
import {
  WorkspaceController,
  type WorkspaceAttachmentHub,
  type WorkspaceHostClient,
  type WorkspacePersistence,
} from "../../workspace/WorkspaceController";
import {
  RESUME_FIXED_DELAY_MS,
  RESUME_PROMPT_TIMEOUT_MS,
  dirExistsVia,
  resumeCommand,
} from "../resume";
import type { DirExists } from "../resume";
import type { LlmProvider, LlmSessionRecord } from "../types";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";
const CODEX_ID = "01999f2a-4c1d-7a52-9e33-b0c1d2e3f4a5";

function record(overrides: Partial<LlmSessionRecord> = {}): LlmSessionRecord {
  return {
    provider: "claude",
    id: CLAUDE_ID,
    title: "Some session",
    cwd: "C:\\Dev\\TermX",
    filePath: "C:\\Users\\x\\.claude\\projects\\C--Dev-TermX\\session.jsonl",
    updatedAtMs: 1,
    summary: null,
    recap: null,
    ...overrides,
  };
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
  /** null = a hub with no direct-write seam at all. */
  sendInput?: ((sessionId: number, data: string | Uint8Array) => boolean) | null;
  createSession?: (cwd: string | null) => Promise<SessionInfo>;
} = {}) {
  const exitListeners = new Set<
    (event: { sessionId: number; exitCode: number | null }) => void
  >();
  const closeListeners = new Set<(event: { sessionId: number }) => void>();
  const createdCwds: Array<string | null> = [];
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
      if (options.createSession) {
        return options.createSession(createOptions.cwd);
      }
      return {
        id: nextSessionId++,
        profile: createOptions.profile ?? "powershell",
        cwd: createOptions.cwd,
        cols: createOptions.cols,
        rows: createOptions.rows,
        alive: true,
        pid: 4242,
      };
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
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
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
    onError: () => () => undefined,
    close: vi.fn(),
  };
  if (options.sendInput !== null) {
    attachments.sendInput = vi.fn((sessionId: number, data: string | Uint8Array) => {
      writes.push([sessionId, data]);
      return options.sendInput ? options.sendInput(sessionId, data) : true;
    });
  }

  const dirExists = vi.fn(options.dirExists ?? (async () => true));
  const controller = new WorkspaceController({
    client,
    store: createLayoutStore(emptyLayout()),
    persistence,
    attachments,
    sessions: [],
    generateId: () => "resumed-tab",
    settings: { getSnapshot: () => ({ ...DEFAULT_SETTINGS, ...options.settings }) },
    dirExists,
  });

  return {
    controller,
    createSession,
    createdCwds,
    dirExists,
    writes,
    notice: () => controller.getSnapshot().notice,
    tabCount: () => controller.getSnapshot().ungroupedTabs.length,
    emitExit(sessionId: number) {
      for (const listener of exitListeners) {
        listener({ sessionId, exitCode: 1 });
      }
    },
    emitClosed(sessionId: number) {
      for (const listener of closeListeners) {
        listener({ sessionId });
      }
    },
  };
}

describe("resumeCommand", () => {
  it("builds the fixed claude verb around a validated id", () => {
    expect(resumeCommand({ provider: "claude", id: CLAUDE_ID })).toBe(
      `claude --resume ${CLAUDE_ID}`,
    );
  });

  it("builds the fixed codex verb around a validated id", () => {
    expect(resumeCommand({ provider: "codex", id: CODEX_ID })).toBe(
      `codex resume ${CODEX_ID}`,
    );
  });

  it("accepts bare alphanumeric and dashed ids", () => {
    for (const id of ["abc", "ABC-123", "0", "a-b-c-d", "-leading-dash"]) {
      expect(resumeCommand({ provider: "claude", id })).toBe(`claude --resume ${id}`);
    }
  });

  it("refuses every id that is not a bare [A-Za-z0-9-] token", () => {
    const hostile = [
      "",
      " ",
      "../evil",
      "..\\evil",
      "id with spaces",
      "id;calc",
      "id&&calc",
      "id|calc",
      "id`calc`",
      "id$(calc)",
      "id\ncalc",
      "id\rcalc",
      "id\r\ncalc",
      "id\tcalc",
      'id"calc"',
      "id'calc'",
      "id>out.txt",
      "id/../../etc",
      "id\u0000calc",
      "idé",
    ];
    for (const id of hostile) {
      expect(resumeCommand({ provider: "claude", id })).toBeNull();
      expect(resumeCommand({ provider: "codex", id })).toBeNull();
    }
  });

  it("refuses unknown providers, including Object.prototype member names", () => {
    for (const provider of ["", "grok", "gemini", "Claude", "constructor", "toString"]) {
      expect(resumeCommand({ provider, id: CLAUDE_ID })).toBeNull();
    }
  });
});

describe("dirExistsVia", () => {
  it("accepts a path that appears in its own completion list", async () => {
    const exists = dirExistsVia(async () => ["C:\\Dev\\OtherX", "c:/dev/termx/"]);
    expect(await exists("C:\\Dev\\TermX")).toBe(true);
  });

  it("accepts a path that lists children when completion misses it", async () => {
    const listDirs = vi.fn(async (prefix: string) =>
      prefix.endsWith("\\") ? ["C:\\Dev\\TermX\\ui"] : [],
    );
    const exists = dirExistsVia(listDirs);
    expect(await exists("C:\\Dev\\TermX")).toBe(true);
    expect(listDirs).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown path, an empty path, and a failing probe", async () => {
    expect(await dirExistsVia(async () => [])("C:\\gone")).toBe(false);
    expect(await dirExistsVia(async () => ["C:\\"])("   ")).toBe(false);
    expect(
      await dirExistsVia(async () => {
        throw new Error("no ipc");
      })("C:\\Dev\\TermX"),
    ).toBe(false);
  });
});

describe("WorkspaceController.resumeSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a malformed id before probing the disk or creating a tab", async () => {
    const h = harness();

    await h.controller.resumeSession(record({ id: "../evil; calc" }));

    expect(h.dirExists).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.notice()).toBe("That session cannot be resumed: its id is not valid.");
  });

  it("refuses a claude session whose folder no longer exists, naming the path", async () => {
    const h = harness({ dirExists: async () => false });

    await h.controller.resumeSession(record({ cwd: "D:\\gone\\project" }));

    expect(h.dirExists).toHaveBeenCalledWith("D:\\gone\\project");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.tabCount()).toBe(0);
    expect(h.notice()).toBe(
      "The session's folder no longer exists (D:\\gone\\project).",
    );
  });

  it("refuses a claude session with no recorded folder", async () => {
    const h = harness();

    await h.controller.resumeSession(record({ cwd: null }));

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe(
      "This session has no recorded folder, so it cannot be resumed.",
    );
  });

  it("treats a probe that throws as a vanished folder", async () => {
    const h = harness({
      dirExists: async () => {
        throw new Error("ipc down");
      },
    });

    await h.controller.resumeSession(record());

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.notice()).toBe(
      "The session's folder no longer exists (C:\\Dev\\TermX).",
    );
  });

  it("degrades a codex session with a vanished folder to a null-cwd tab", async () => {
    const h = harness({ dirExists: async () => false });

    const done = h.controller.resumeSession(
      record({ provider: "codex", id: CODEX_ID, cwd: "D:\\gone" }),
    );
    await settleMicrotasks();
    h.controller.reportSessionCwd(50, "C:\\Users\\x", true);
    await done;

    expect(h.createdCwds).toEqual([null]);
    expect(h.tabCount()).toBe(1);
    expect(h.writes).toEqual([[50, `codex resume ${CODEX_ID}\r`]]);
    expect(h.notice()).toBeNull();
  });

  it("opens the tab in the session's folder and types the exact bytes on the first live cwd report", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    expect(h.writes).toEqual([]);

    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;

    expect(h.createdCwds).toEqual(["C:\\Dev\\TermX"]);
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBeNull();
  });

  it("ignores replayed reports and other sessions' reports while waiting", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.controller.reportSessionCwd(50, "C:\\replayed", false);
    h.controller.reportSessionCwd(51, "C:\\other-session", true);
    await settleMicrotasks();
    expect(h.writes).toEqual([]);

    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("sends anyway when the prompt never reports within 15 s", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RESUME_PROMPT_TIMEOUT_MS - 1);
    expect(h.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("waits a fixed 1.5 s instead of a prompt signal when shell integration is off", async () => {
    const h = harness({ settings: { shellIntegration: false } });

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(RESUME_FIXED_DELAY_MS - 1);
    // A cwd report must not shorten the fixed delay: without integration it
    // cannot mean "prompt ready".
    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await settleMicrotasks();
    expect(h.writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.writes).toEqual([[50, `claude --resume ${CLAUDE_ID}\r`]]);
  });

  it("drops the waiter and sends nothing when the session dies first", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.emitExit(50);
    await done;

    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBe("The terminal ended before the session could be resumed.");

    // The waiter is gone: nothing fires later, from either signal.
    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await vi.advanceTimersByTimeAsync(RESUME_PROMPT_TIMEOUT_MS * 2);
    expect(h.writes).toEqual([]);
  });

  it("drops the waiter when the session is closed out from under the resume", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.emitClosed(50);
    await done;

    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports when the hub cannot take the input", async () => {
    const h = harness({ sendInput: () => false });

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;

    expect(h.notice()).toBe("The resume command could not be sent to the terminal.");
  });

  it("reports when the hub has no direct-write seam", async () => {
    const h = harness({ sendInput: null });

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.controller.reportSessionCwd(50, "C:\\Dev\\TermX", true);
    await done;

    expect(h.notice()).toBe("The resume command could not be sent to the terminal.");
  });

  it("reports a creation failure without waiting or typing", async () => {
    const h = harness({
      createSession: async () => {
        throw new Error("host refused");
      },
    });

    await h.controller.resumeSession(record());

    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.notice()).toBe("The terminal session could not be created.");
  });

  it("releases a pending waiter on dispose", async () => {
    const h = harness();

    const done = h.controller.resumeSession(record());
    await settleMicrotasks();
    h.controller.dispose();
    await done;

    expect(h.writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("AttachmentHub resume input seam", () => {
  function hostFixture() {
    const sendInput = vi.fn();
    const client: AttachmentHostClient = {
      attach: vi.fn(async (
        sessionId: number,
        _callbacks: SessionAttachmentCallbacks = {},
        _replay = true,
      ) => ({
        sessionId,
        nextOffset: 0n,
        sendInput,
        resize: vi.fn(),
        detach: vi.fn(),
      } satisfies SessionAttachment)),
      onError: () => () => undefined,
      onSessionClosed: () => () => undefined,
    };
    return { client, sendInput };
  }

  it("writes through the physical attachment even while a terminal is bound", async () => {
    const { client, sendInput } = hostFixture();
    const hub = new AttachmentHub(client);
    await hub.attachSession(7);
    await hub.attach(7, {});

    expect(hub.sendInput(7, `claude --resume ${CLAUDE_ID}\r`)).toBe(true);
    expect(sendInput).toHaveBeenCalledWith(`claude --resume ${CLAUDE_ID}\r`);
    hub.close();
  });

  it("answers false for an unattached session, a failing write, and a closed hub", async () => {
    const { client, sendInput } = hostFixture();
    const hub = new AttachmentHub(client);
    expect(hub.sendInput(9, "x")).toBe(false);

    await hub.attachSession(9);
    sendInput.mockImplementationOnce(() => {
      throw new Error("transport gone");
    });
    expect(hub.sendInput(9, "x")).toBe(false);

    hub.close();
    expect(hub.sendInput(9, "x")).toBe(false);
  });
});

/** The provider union stays closed: every member must be resumable. */
it("covers every declared provider", () => {
  const providers: LlmProvider[] = ["claude", "codex"];
  for (const provider of providers) {
    expect(resumeCommand({ provider, id: CLAUDE_ID })).not.toBeNull();
  }
});
