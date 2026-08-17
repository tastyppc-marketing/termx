/**
 * Remote title probe (ssh-sessions spec §3).
 *
 * The probe exists so a `/rename` done on the VPS is what the save dialog
 * shows. Everything else here is about what it must NOT do: never place
 * anything but a validated id on a remote command line, never let remote output
 * through unshaped, and never turn a failure into anything but null.
 */

import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_TITLE_TIMEOUT_MS,
  probeRemoteTitle,
  remoteTitleCommand,
  shapeRemoteTitle,
} from "../sshProbe";

const CLAUDE_ID = "0f4b1c2e-9a77-4d31-8b0e-2c5d6e7f8a90";

describe("remoteTitleCommand", () => {
  it("reads the newest summary out of the id's transcript", () => {
    const command = remoteTitleCommand(CLAUDE_ID);
    expect(command).toContain(`-name '${CLAUDE_ID}.jsonl'`);
    expect(command).toContain('$HOME/.claude/projects');
    // The LAST summary is the current title: a remote /rename appends.
    expect(command).toContain("tail -1");
  });

  it("refuses every id that is not a bare token", () => {
    for (const id of [
      "",
      "../evil",
      "id; rm -rf /",
      "id$(id)",
      "id`id`",
      "id'x'",
      'id"x"',
      "id with spaces",
      "id\nid",
      "*",
    ]) {
      expect(remoteTitleCommand(id)).toBeNull();
    }
  });
});

describe("shapeRemoteTitle", () => {
  it("takes the last non-empty line and trims it", () => {
    expect(shapeRemoteTitle("Warning: banner\n  Daemon work  \n\n")).toBe(
      "Daemon work",
    );
  });

  it("has nothing to say about nothing", () => {
    expect(shapeRemoteTitle(null)).toBeNull();
    expect(shapeRemoteTitle("")).toBeNull();
    expect(shapeRemoteTitle("   \n\n")).toBeNull();
  });

  it("strips control characters and caps the length", () => {
    expect(shapeRemoteTitle("a\u0007b\u001b[31mc")).toBe("abc");
    expect(shapeRemoteTitle("x".repeat(500))).toHaveLength(200);
  });
});

describe("probeRemoteTitle", () => {
  it("probes the host and shapes what comes back", async () => {
    const probe = vi.fn(async () => "Daemon work\n");

    const title = await probeRemoteTitle("myvps", "claude", CLAUDE_ID, probe);

    expect(title).toBe("Daemon work");
    expect(probe).toHaveBeenCalledWith(
      "myvps",
      remoteTitleCommand(CLAUDE_ID),
      REMOTE_TITLE_TIMEOUT_MS,
    );
  });

  it("degrades to null when the host cannot be reached", async () => {
    expect(
      await probeRemoteTitle("myvps", "claude", CLAUDE_ID, async () => null),
    ).toBeNull();
  });

  it("probes nothing for codex, whose titles are not on the host", async () => {
    const probe = vi.fn(async () => "irrelevant");

    expect(await probeRemoteTitle("myvps", "codex", CLAUDE_ID, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes nothing for an id it would have had to escape", async () => {
    const probe = vi.fn(async () => "irrelevant");

    expect(
      await probeRemoteTitle("myvps", "claude", "../evil; calc", probe),
    ).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
