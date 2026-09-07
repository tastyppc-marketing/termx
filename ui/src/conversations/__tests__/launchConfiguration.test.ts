import { describe, expect, it } from "vitest";
import { parseLaunchConfiguration, resumeArguments, parseConversationLaunches } from "../launchConfiguration";
import { resumeCommand, remoteResumeCommand } from "../resume";

const launch = (provider: "claude" | "codex", args: string[]) => ({ v: 1 as const, provider, args, cwd: "C:\\Projects\\one" });

describe("launch configuration", () => {
  it("preserves Codex configuration ordering and repeats, replacing only selection and prompt", () => {
    expect(resumeArguments(launch("codex", ["-c", 'model_reasoning_effort="high"', "--model", "gpt-test", "resume", "old-id", "--last", "-c", 'features.foo=true', "--add-dir", "../shared", "--dangerously-bypass-approvals-and-sandbox", "initial prompt"]), "new-id")).toEqual([
      "resume", "new-id", "-c", 'model_reasoning_effort="high"', "--model", "gpt-test", "-c", 'features.foo=true', "--add-dir", "../shared", "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("preserves Claude tools, plugin/settings paths and custom system prompts without replaying the user prompt", () => {
    expect(resumeArguments(launch("claude", ["--session-id", "old-id", "--model=sonnet", "--permission-mode", "plan", "--allowedTools", "Read", "Bash(git:*)", "--plugin-dir", "C:\\Plugins\\O'Brien", "--append-system-prompt", "", "--", "initial prompt"]), "new-id")).toEqual([
      "--resume", "new-id", "--model=sonnet", "--permission-mode", "plan", "--allowedTools", "Read", "Bash(git:*)", "--plugin-dir", "C:\\Plugins\\O'Brien", "--append-system-prompt", "",
    ]);
  });

  it("refuses ambiguous unknown flags and noninteractive modes instead of dropping settings", () => {
    for (const args of [["--new-unknown", "value"], ["exec", "prompt"], ["--model"]]) {
      expect(resumeArguments(launch("codex", args), "id")).toBeNull();
    }
    expect(resumeArguments(launch("claude", ["--print", "prompt"]), "id")).toBeNull();
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
