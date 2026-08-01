/**
 * Bootstrap wiring for the conversations store: loaded like settings/ui-state
 * (optional field, tolerant, never blocking) and — critically — without
 * scanning any session on startup.
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionAttachment, SessionAttachmentCallbacks } from "../../host/client";
import { emptyLayout, serializeLayout } from "../../state/layout";
import type { AppFileStore } from "../../native/appFiles";
import {
  bootstrapWorkspace,
  type BootstrapWorkspaceClient,
} from "../../workspace/bootstrapWorkspace";
import { CONVERSATIONS_FILE, serializeConversations } from "../storage";
import type { SessionLister } from "../types";

function fakeClient(): BootstrapWorkspaceClient {
  return {
    createSession: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({
      layout: serializeLayout(emptyLayout()),
      sessions: [],
    })),
    setLayout: vi.fn(async () => undefined),
    attach: vi.fn(async (
      sessionId: number,
      callbacks: SessionAttachmentCallbacks = {},
    ) => {
      void callbacks;
      return {
        sessionId,
        nextOffset: 0n,
        sendInput: vi.fn(),
        resize: vi.fn(),
        detach: vi.fn(),
      } satisfies SessionAttachment;
    }),
    onSessionExited: () => () => undefined,
    onSessionClosed: () => () => undefined,
    onError: () => () => undefined,
    close: vi.fn(),
  };
}

function fakeAppFiles(seed: Record<string, string>) {
  const writes: [string, string][] = [];
  const files: AppFileStore = {
    read: async (name) => seed[name] ?? null,
    write: async (name, contents) => {
      writes.push([name, contents]);
    },
  };
  return { files, writes };
}

async function boot(options: {
  seed?: Record<string, string>;
  list?: SessionLister;
}) {
  const { files, writes } = fakeAppFiles(options.seed ?? {});
  const list = options.list ?? vi.fn<SessionLister>(async () => []);
  const workspace = await bootstrapWorkspace({
    invokeBootstrap: async () => ({ port: 4242, token: "secret" }),
    connect: async () => fakeClient(),
    appFiles: files,
    listSessions: list,
  });
  return { workspace, writes, list };
}

describe("bootstrapWorkspace conversations", () => {
  it("loads conversations_v1.json and never scans sessions on startup", async () => {
    const { workspace, list } = await boot({
      seed: {
        [CONVERSATIONS_FILE]: serializeConversations({
          version: 1,
          folders: [{ id: "f1", name: "Work" }],
          assignments: { "claude:a": "f1" },
          generated: {},
        }),
      },
    });

    expect(workspace.conversations?.getSnapshot().data.folders).toEqual([
      { id: "f1", name: "Work" },
    ]);
    expect(workspace.conversations?.getSnapshot().refreshedAtMs).toBeNull();
    expect(list).not.toHaveBeenCalled();
    workspace.controller.dispose();
  });

  it("degrades to empty state for a corrupt file and persists edits back", async () => {
    const { workspace, writes } = await boot({
      seed: { [CONVERSATIONS_FILE]: "{ not json" },
    });
    const store = workspace.conversations!;
    expect(store.getSnapshot().data.folders).toEqual([]);

    store.createFolder("Client");
    await store.flush();

    const write = writes.find(([name]) => name === CONVERSATIONS_FILE);
    expect(write).toBeDefined();
    expect(JSON.parse(write![1]).folders[0].name).toBe("Client");
    workspace.controller.dispose();
  });
});
