import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../host/protocol";
import {
  DEFAULT_SESSION_COLS,
  DEFAULT_SESSION_ROWS,
  createSessionWithCwd,
  duplicateTab,
  openFolderHere,
  pickFolderAndCreateSession,
  type SessionCreator,
} from "../folderSession";
import { pickFolder, type FolderPicker } from "../dialog";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 1,
    profile: "powershell",
    cwd: "C:\\projects\\termx",
    cols: DEFAULT_SESSION_COLS,
    rows: DEFAULT_SESSION_ROWS,
    alive: true,
    pid: 4242,
    ...overrides,
  };
}

function fakeClient(
  impl?: SessionCreator["createSession"],
): SessionCreator & { createSession: ReturnType<typeof vi.fn> } {
  const createSession = vi.fn(
    impl ??
      (async (options) =>
        makeSession({
          profile: options.profile ?? "powershell",
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          id: 99,
        })),
  );
  return { createSession };
}

describe("pickFolder", () => {
  it("returns the absolute path chosen by the injected picker", async () => {
    const picker: FolderPicker = vi.fn(async () => "D:\\code\\app");
    await expect(pickFolder({ title: "Open folder" }, picker)).resolves.toBe(
      "D:\\code\\app",
    );
    expect(picker).toHaveBeenCalledWith({ title: "Open folder" });
  });

  it("propagates cancel as null", async () => {
    const picker: FolderPicker = vi.fn(async () => null);
    await expect(pickFolder({}, picker)).resolves.toBeNull();
  });
});

describe("createSessionWithCwd", () => {
  it("forwards profile, absolute cwd, and default size", async () => {
    const client = fakeClient();
    const info = await createSessionWithCwd(client, {
      profile: "cmd",
      cwd: "C:\\Dev\\TermX",
    });

    expect(client.createSession).toHaveBeenCalledWith({
      profile: "cmd",
      cwd: "C:\\Dev\\TermX",
      cols: DEFAULT_SESSION_COLS,
      rows: DEFAULT_SESSION_ROWS,
    });
    expect(info.cwd).toBe("C:\\Dev\\TermX");
    expect(info.profile).toBe("cmd");
  });

  it("honors explicit cols/rows", async () => {
    const client = fakeClient();
    await createSessionWithCwd(client, {
      profile: null,
      cwd: "C:\\tmp",
      cols: 80,
      rows: 24,
    });
    expect(client.createSession).toHaveBeenCalledWith({
      profile: null,
      cwd: "C:\\tmp",
      cols: 80,
      rows: 24,
    });
  });
});

describe("pickFolderAndCreateSession", () => {
  it("creates a session with the picked folder as cwd", async () => {
    const client = fakeClient();
    const pick: FolderPicker = vi.fn(async () => "E:\\workspace");

    const info = await pickFolderAndCreateSession(
      { client, pickFolder: pick },
      { profile: "powershell", picker: { title: "Open folder" } },
    );

    expect(pick).toHaveBeenCalledWith({ title: "Open folder" });
    expect(client.createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "E:\\workspace",
      cols: DEFAULT_SESSION_COLS,
      rows: DEFAULT_SESSION_ROWS,
    });
    expect(info).toEqual(
      expect.objectContaining({
        cwd: "E:\\workspace",
        profile: "powershell",
      }),
    );
  });

  it("returns null and never hits the host when the user cancels", async () => {
    const client = fakeClient();
    const pick: FolderPicker = vi.fn(async () => null);

    const info = await pickFolderAndCreateSession({
      client,
      pickFolder: pick,
    });

    expect(info).toBeNull();
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

describe("openFolderHere", () => {
  it("seeds the picker from the source cwd and reuses the source profile", async () => {
    const client = fakeClient();
    const pick: FolderPicker = vi.fn(async (opts) => {
      expect(opts?.defaultPath).toBe("C:\\work\\src");
      return "C:\\work\\other";
    });

    const info = await openFolderHere(
      { client, pickFolder: pick },
      { profile: "cmd", cwd: "C:\\work\\src" },
      { cols: 100, rows: 40 },
    );

    expect(client.createSession).toHaveBeenCalledWith({
      profile: "cmd",
      cwd: "C:\\work\\other",
      cols: 100,
      rows: 40,
    });
    expect(info?.cwd).toBe("C:\\work\\other");
  });

  it("omits defaultPath when the source cwd is null", async () => {
    const client = fakeClient();
    const pick: FolderPicker = vi.fn(async (opts) => {
      expect(opts?.defaultPath).toBeUndefined();
      return "C:\\Users\\public";
    });

    await openFolderHere(
      { client, pickFolder: pick },
      { profile: null, cwd: null },
    );

    expect(client.createSession).toHaveBeenCalledWith({
      profile: null,
      cwd: "C:\\Users\\public",
      cols: DEFAULT_SESSION_COLS,
      rows: DEFAULT_SESSION_ROWS,
    });
  });
});

describe("duplicateTab", () => {
  it("creates a new session with the same profile and cwd", async () => {
    const client = fakeClient();
    const info = await duplicateTab(
      { client },
      { profile: "powershell", cwd: "C:\\Dev\\TermX" },
    );

    expect(client.createSession).toHaveBeenCalledWith({
      profile: "powershell",
      cwd: "C:\\Dev\\TermX",
      cols: DEFAULT_SESSION_COLS,
      rows: DEFAULT_SESSION_ROWS,
    });
    expect(info.cwd).toBe("C:\\Dev\\TermX");
    expect(info.profile).toBe("powershell");
  });

  it("duplicates a null-cwd tab without inventing a path", async () => {
    const client = fakeClient();
    await duplicateTab({ client }, { profile: "cmd", cwd: null }, {
      cols: 80,
      rows: 25,
    });

    expect(client.createSession).toHaveBeenCalledWith({
      profile: "cmd",
      cwd: null,
      cols: 80,
      rows: 25,
    });
  });
});
