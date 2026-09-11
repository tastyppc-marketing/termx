import { describe, expect, it } from "vitest";
import { parseLaunchConfiguration, resumeArguments, parseConversationLaunches } from "../launchConfiguration";
import { resumeCommand, remoteResumeCommand } from "../resume";

const launch = (provider: "claude" | "codex", args: string[]) => ({ v: 1 as const, provider, args, cwd: "C:\\Projects\\one" });

describe("launch configuration", () => {
  it("preserves Codex configuration ordering and repeats, replacing only selection and prompt", () => {
    expect(resumeArguments(launch("codex", ["-c", 'model_reasoning_effort="high"', "--model", "gpt-test", "resume", "old-id", "--last", "-c", 'features.foo=true', "--add-dir", "../shared", "--dangerously-bypass-approvals-and-sandbox", "initial prompt"]), "new-id")).toEqual([
      "-c", 'model_reasoning_effort="high"', "--model", "gpt-test", "resume", "new-id", "-c", 'features.foo=true', "--add-dir", "../shared", "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("preserves Claude tools, plugin/settings paths and custom system prompts without replaying the user prompt", () => {
    expect(resumeArguments(launch("claude", ["--session-id", "old-id", "--model=sonnet", "--permission-mode", "plan", "--allowedTools", "Read", "Bash(git:*)", "--plugin-dir", "C:\\Plugins\\O'Brien", "--append-system-prompt", "", "--", "initial prompt"]), "new-id")).toEqual([
      "--resume", "new-id", "--model=sonnet", "--permission-mode", "plan", "--allowedTools", "Read", "Bash(git:*)", "--plugin-dir", "C:\\Plugins\\O'Brien", "--append-system-prompt", "",
    ]);
  });

  it("preserves new switches and inline settings without replaying an initial prompt", () => {
    expect(resumeArguments(launch("codex", ["--flex", "--future-config=some value", "--dangerously-bypass-approvals-and-sandbox", "one-off prompt"]), "new-id"))
      .toEqual(["--flex", "--future-config=some value", "--dangerously-bypass-approvals-and-sandbox", "resume", "new-id"]);
    expect(resumeArguments(launch("claude", ["--future-config=some value", "--dangerously-skip-permissions", "one-off prompt", "--new-switch"]), "new-id"))
      .toEqual(["--resume", "new-id", "--future-config=some value", "--dangerously-skip-permissions", "--new-switch"]);
  });

  it("keeps opaque option values before an explicit prompt boundary", () => {
    expect(resumeArguments(launch("codex", ["--future-config", "some value", "--future-list", "first", "second", "--flex", "--", "one-off prompt"]), "new-id"))
      .toEqual(["--future-config", "some value", "--future-list", "first", "second", "--flex", "resume", "new-id"]);
  });

  it("preserves Codex option placement around its resume subcommand", () => {
    expect(resumeArguments(launch("codex", ["--future-root=enabled", "resume", "old-id", "--flex", "--model", "custom-model", "one-off prompt"]), "new-id"))
      .toEqual(["--future-root=enabled", "resume", "new-id", "--flex", "--model", "custom-model"]);
    expect(resumeArguments(launch("codex", ["-cmodel_reasoning_effort=high", "-mcustom-model", "one-off prompt"]), "new-id"))
      .toEqual(["-cmodel_reasoning_effort=high", "-mcustom-model", "resume", "new-id"]);
  });

  it("removes attached old conversation selectors and one-off image attachments", () => {
    expect(resumeArguments(launch("claude", ["-rold-id", "--dangerously-skip-permissions"]), "new-id"))
      .toEqual(["--resume", "new-id", "--dangerously-skip-permissions"]);
    expect(resumeArguments(launch("codex", ["-iinitial.png", "--flex"]), "new-id"))
      .toEqual(["--flex", "resume", "new-id"]);
  });

  it("does not treat a terminal separator as proof that an unknown value was not the prompt", () => {
    expect(resumeArguments(launch("codex", ["--future-switch", "one-off prompt", "--"]), "new-id")).toBeNull();
  });

  it("removes inline selection switches so they cannot conflict with the requested conversation", () => {
    expect(resumeArguments(launch("claude", ["--continue=true", "-c=true", "--fork-session=true", "--model", "custom"]), "new-id"))
      .toEqual(["--resume", "new-id", "--model", "custom"]);
    expect(resumeArguments(launch("codex", ["resume", "old-id", "--last=true", "--all=true", "--include-non-interactive=true", "--flex"]), "new-id"))
      .toEqual(["resume", "new-id", "--flex"]);
  });

  it("refuses an ambiguous Codex selector inside opaque values instead of duplicating resume", () => {
    for (const args of [
      ["--flex", "resume", "old-id", "--", "one-off prompt"],
      ["--future-root", "value", "resume", "old-id", "--", "one-off prompt"],
      ["--future-root", "value", "exec", "--", "one-off prompt"],
    ]) expect(resumeArguments(launch("codex", args), "new-id")).toBeNull();
  });

  it("refuses ambiguous unknown values and noninteractive modes instead of dropping settings or replaying prompts", () => {
    for (const args of [["--new-unknown", "value"], ["exec", "prompt"], ["--model"]]) {
      expect(resumeArguments(launch("codex", args), "id")).toBeNull();
    }
    expect(resumeArguments(launch("claude", ["--print", "prompt"]), "id")).toBeNull();
    expect(resumeArguments(launch("claude", ["--print"]), "id")).toBeNull();
    expect(resumeArguments(launch("codex", ["--unknown-boolean", "one-off prompt"]), "id")).toBeNull();
  });

  it("requires bounded typed configuration with a matching provider", () => {
    expect(parseLaunchConfiguration(launch("codex", ["--model", "test"]), "claude")).toBeNull();
    expect(parseLaunchConfiguration(launch("codex", ["bad\u0000argument"]), "codex")).toBeNull();
    expect(parseLaunchConfiguration({ ...launch("codex", []), v: 2 }, "codex")).toBeNull();
  });

  it("preserves boolean approval mode and handles selectors after intervening flags", () => {
    expect(resumeArguments(launch("codex", ["resume", "--model", "test", "old-id", "--approve-for-me", "initial prompt"]), "new-id"))
      .toEqual(["resume", "new-id", "--model", "test", "--approve-for-me"]);
    expect(resumeArguments(launch("claude", ["--plugin-dir", "./plugin", "initial prompt"]), "new-id"))
      .toEqual(["--resume", "new-id", "--plugin-dir", "./plugin"]);
  });

  it("uses structured native transport under both Windows shells", () => {
    const record = { provider: "claude", id: "abc-123", launch: launch("claude", ["--append-system-prompt", '雪 "quotes" %PATH% !X! $(touch pwned)', "--model", "sonnet"]) };
    for (const shell of ["cmd", "powershell"]) {
      const command = resumeCommand(record, shell)!;
      const token = command.split(" ").at(-1)!;
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
      expect(payload).toEqual({ v: 1, provider: "claude", args: ["--resume", "abc-123", ...record.launch.args], cwd: record.launch.cwd });
      expect(command).not.toContain("touch");
      expect(command).toContain("TERMX_HOST_EXE");
    }
  });

  it("keeps the first captured baseline per provider and conversation across later bare resumes", () => {
    const rows = [
      { provider: "codex", id: "same", launch: launch("codex", ["--model", "original"]) },
      { provider: "claude", id: "same", launch: launch("claude", ["--model", "sonnet"]) },
      { provider: "codex", id: "same", launch: launch("codex", ["resume", "same"]) },
    ];
    const parsed = parseConversationLaunches(rows.map(row => JSON.stringify({ v: 1, ...row })).join("\n"));
    expect(parsed.get("codex:same")?.args).toEqual(["--model", "original"]);
    expect(parsed.get("claude:same")?.args).toEqual(["--model", "sonnet"]);
    expect(parseConversationLaunches(JSON.stringify({ v: 1, provider: "codex", id: "corrupt", launch: { v: 2 } })).get("codex:corrupt")).toBeNull();
  });

  it("keeps old records resumable, refuses invalid captures and shell-quotes configured remote values", () => {
    expect(resumeCommand({ provider: "codex", id: "abc" })).toBe("codex resume abc");
    expect(resumeCommand({ provider: "codex", id: "abc", launch: null })).toBeNull();
    expect(resumeCommand({ provider: "codex", id: "--last" })).toBeNull();
    expect(resumeCommand({ provider: "claude", id: "--dangerously-skip-permissions" })).toBeNull();
    expect(remoteResumeCommand({ provider: "claude", id: "abc", title: "t", launch: { ...launch("claude", ["--model", "O'Brien"]), cwd: "/project" } })).toBe("cd -- '/project' && claude '--resume' 'abc' '--model' 'O'\\''Brien'");
  });
});
