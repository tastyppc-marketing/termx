/**
 * The connect command is typed into a local shell and then interpreted by a
 * remote one, so it is two quoting problems stacked. These tests pin both
 * halves: the outer one-liner must be a single-quoted string with nothing in it
 * that could close that quote (which base64 guarantees), and the decoded remote
 * script must be valid bash for every remote path a user can pin — spaces and
 * apostrophes included.
 */

import { describe, expect, it } from "vitest";
import { remoteRcScript, sshConnectCommand } from "../bootstrap";

/** The base64 blob the one-liner pipes into `base64 -d`. */
function payloadOf(command: string): string {
  const match = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command);
  expect(match, `no payload in ${command}`).not.toBeNull();
  return match![1]!;
}

function decodedScript(command: string): string {
  return Buffer.from(payloadOf(command), "base64").toString("utf8");
}

describe("sshConnectCommand", () => {
  it("wraps a base64 one-liner in single quotes, ssh -t, for the alias", () => {
    const command = sshConnectCommand("myvps");
    expect(command.startsWith("ssh -t myvps '")).toBe(true);
    expect(command.endsWith("'")).toBe(true);
    // The payload is the only user-influenced part of the outer string, and the
    // base64 alphabet cannot contain the quote that would end it.
    expect(payloadOf(command)).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Exactly two quotes in the whole command: the ones ssh's argument needs.
    expect(command.split("'")).toHaveLength(3);
  });

  it("decodes the payload to a temp rcfile and execs an interactive bash", () => {
    const command = sshConnectCommand("myvps");
    expect(command).toContain("tmp=$(mktemp)");
    expect(command).toContain('base64 -d > "$tmp"');
    // TERMX_RC carries the path across the exec so the rcfile can delete itself.
    expect(command).toContain('TERMX_RC="$tmp" exec bash --rcfile "$tmp" -i');
  });

  it("hands the same script `remoteRcScript` returns", () => {
    expect(decodedScript(sshConnectCommand("myvps"))).toBe(remoteRcScript());
    expect(decodedScript(sshConnectCommand("myvps", { remoteCwd: "/srv" }))).toBe(
      remoteRcScript({ remoteCwd: "/srv" }),
    );
  });

  it("refuses an alias that is not a plain ssh config alias", () => {
    for (const alias of [
      "",
      "my vps",
      "a;rm -rf /",
      "$(whoami)",
      "a'b",
      "host&",
      "`id`",
      "-oProxyCommand=x",
    ]) {
      expect(() => sshConnectCommand(alias), alias).toThrow(/alias/i);
    }
  });

  it("accepts the alias shapes ssh config actually uses", () => {
    for (const alias of ["myvps", "TastyVPS", "web-1", "box.example.net", "a_b"]) {
      expect(() => sshConnectCommand(alias)).not.toThrow();
    }
  });
});

describe("remoteRcScript", () => {
  const script = remoteRcScript();

  it("sources the user's bashrc before setting anything of its own", () => {
    expect(script).toContain("[ -f ~/.bashrc ] && . ~/.bashrc");
    // Order matters: a bashrc that sets PROMPT_COMMAND would otherwise win and
    // TermX would never see a cwd report.
    expect(script.indexOf(".bashrc")).toBeLessThan(script.indexOf("PROMPT_COMMAND"));
  });

  it("reports the remote cwd on the same OSC 9;9 channel local shells use", () => {
    expect(script).toContain(
      String.raw`PROMPT_COMMAND='printf "\033]9;9;%s\033\\" "$PWD"'`,
    );
  });

  it("wraps claude and codex so a new session announces its id", () => {
    expect(script).toMatch(/^claude\(\) \{$/m);
    expect(script).toMatch(/^codex\(\) \{$/m);
    expect(script).toContain(String.raw`\033]9;78;claude;%s\033\\`);
    expect(script).toContain(String.raw`\033]9;78;codex;%s\033\\`);
    // The real binary still runs, and in the foreground.
    expect(script).toContain('command claude "$@"');
    expect(script).toContain('command codex "$@"');
    // Each provider watches its own transcript dir.
    expect(script).toContain('"$HOME/.claude/projects"');
    expect(script).toContain('"$HOME/.codex/sessions"');
  });

  it("writes the capture to the tty, not to stdout the agent is drawing on", () => {
    expect(script).toContain("> /dev/tty");
  });

  it("bounds the watcher and cleans up after itself", () => {
    // Two minutes of polling at 0.5s, then the subshell exits on its own: a
    // pane left open for a week must not keep a background loop alive.
    expect(script).toContain("for _ in $(seq 1 240); do");
    expect(script).toContain("sleep 0.5");
    expect(script).toContain('rm -f "$stamp"');
    // And the rcfile removes itself once bash has read it.
    expect(script.trimEnd().endsWith('rm -f "$TERMX_RC"')).toBe(true);
  });

  it("uses no `local` inside the watcher subshell", () => {
    // `local` is only valid directly in a function body; inside `( … )` bash
    // errors on every iteration and the capture silently never happens.
    for (const subshell of script.match(/\(\n[\s\S]*?\n {2}\) 2>\/dev\/null &/g) ??
      []) {
      expect(subshell).not.toContain("local ");
    }
    expect(script.match(/\(\n[\s\S]*?\n {2}\) 2>\/dev\/null &/g)).toHaveLength(2);
  });

  it("does not cd when no remote folder was asked for", () => {
    expect(script).not.toContain("\ncd ");
  });
});

describe("remoteRcScript with a remote folder", () => {
  it("cds into a plain path", () => {
    expect(remoteRcScript({ remoteCwd: "/root/code" })).toContain(
      "\ncd '/root/code'",
    );
  });

  it("survives spaces and apostrophes in the path", () => {
    expect(remoteRcScript({ remoteCwd: "/root/my app" })).toContain(
      "\ncd '/root/my app'",
    );
    // The only way out of a single-quoted string: close, escape, reopen.
    expect(remoteRcScript({ remoteCwd: "/root/it's here" })).toContain(
      String.raw`cd '/root/it'\''s here'`,
    );
    expect(remoteRcScript({ remoteCwd: "/a'; rm -rf /; '" })).toContain(
      String.raw`cd '/a'\''; rm -rf /; '\'''`,
    );
  });

  it("cds after the wrappers are defined, so the prompt hook is already live", () => {
    const script = remoteRcScript({ remoteCwd: "/root/code" });
    expect(script.indexOf("codex() {")).toBeLessThan(script.indexOf("\ncd '"));
  });

  it("ignores an empty folder like an absent one", () => {
    expect(remoteRcScript({ remoteCwd: "" })).toBe(remoteRcScript());
  });

  it("keeps the payload single-quote-free even for an apostrophe path", () => {
    const command = sshConnectCommand("myvps", { remoteCwd: "/root/it's here" });
    expect(command.split("'")).toHaveLength(3); // ssh -t myvps '…'
  });
});
