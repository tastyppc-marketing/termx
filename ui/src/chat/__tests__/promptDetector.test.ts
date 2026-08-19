/**
 * PromptDetector fixtures.
 *
 * PROVENANCE. TermX's own scrollback spill (`%APPDATA%\termx\history\*.bin`)
 * was searched for captured permission screens and holds none — the spilled
 * sessions are plain shells. Every `fixtures/prompts/*.txt` file is therefore a
 * transcription of Claude Code's published TUI layouts (v2.1.x): the boxed
 * Bash/Edit permission dialogs, the AskUserQuestion menu, the ExitPlanMode
 * approval and the first-run folder-trust screen, plus two plain-CLI y/N
 * confirms. Negatives are real output shapes taken verbatim from this
 * session's own terminal (cargo build, vitest summary, PowerShell prompt,
 * agent prose, a failures header).
 *
 * When Claude Code's UI changes, the fix is a new fixture here plus whatever
 * pattern it demands — the detector is deliberately one module.
 */

import { describe, expect, it } from "vitest";
import { detectPrompt, keysForMenuAnswer } from "../promptDetector";

import askUserQuestion from "./fixtures/prompts/ask-user-question.txt?raw";
import confirmYesNo from "./fixtures/prompts/confirm-yes-no.txt?raw";
import confirmYn from "./fixtures/prompts/confirm-yn.txt?raw";
import folderTrust from "./fixtures/prompts/folder-trust.txt?raw";
import negativeAgentOutput from "./fixtures/prompts/negative-agent-output.txt?raw";
import negativeBuildLog from "./fixtures/prompts/negative-build-log.txt?raw";
import negativeFailuresHeader from "./fixtures/prompts/negative-failures-header.txt?raw";
import negativeShellPrompt from "./fixtures/prompts/negative-shell-prompt.txt?raw";
import negativeTestSummary from "./fixtures/prompts/negative-test-summary.txt?raw";
import permissionBashThird from "./fixtures/prompts/permission-bash-third-selected.txt?raw";
import permissionBash from "./fixtures/prompts/permission-bash.txt?raw";
import permissionEdit from "./fixtures/prompts/permission-edit.txt?raw";
import planApproval from "./fixtures/prompts/plan-approval.txt?raw";

const lines = (fixture: string) => fixture.split("\n");

describe("detectPrompt", () => {
  it("reads the Bash permission dialog: question, options, selection", () => {
    const prompt = detectPrompt(lines(permissionBash));
    expect(prompt?.kind).toBe("menu");
    if (prompt?.kind !== "menu") {
      throw new Error("not a menu");
    }
    expect(prompt.question).toBe("Do you want to proceed?");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for npm commands in C:\\Dev\\TermX",
      "No, and tell Claude what to do differently (esc)",
    ]);
    expect(prompt.options.map((option) => option.index)).toEqual([0, 1, 2]);
    expect(prompt.selectedIndex).toBe(0);
    expect(prompt.raw.some((line) => line.includes("npm run build"))).toBe(true);
  });

  it("tracks the selector wherever it sits", () => {
    const prompt = detectPrompt(lines(permissionBashThird));
    expect(prompt?.kind === "menu" && prompt.selectedIndex).toBe(2);
  });

  it("reads the edit-permission dialog", () => {
    const prompt = detectPrompt(lines(permissionEdit));
    expect(prompt?.kind === "menu" && prompt.question).toBe(
      "Do you want to make this edit to ChatView.tsx?",
    );
    expect(prompt?.kind === "menu" && prompt.options).toHaveLength(3);
  });

  it("reads an AskUserQuestion menu that has no numbers", () => {
    const prompt = detectPrompt(lines(askUserQuestion));
    expect(prompt?.kind).toBe("menu");
    if (prompt?.kind !== "menu") {
      throw new Error("not a menu");
    }
    expect(prompt.question).toBe("Which approach should I take for the sidebar?");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Refactor the existing tree in place",
      "Rewrite it around nested groups",
      "Leave it alone for now",
    ]);
    expect(prompt.selectedIndex).toBe(0);
  });

  it("reads the plan-approval prompt", () => {
    const prompt = detectPrompt(lines(planApproval));
    expect(prompt?.kind === "menu" && prompt.question).toBe(
      "Would you like to proceed?",
    );
    expect(
      prompt?.kind === "menu" && prompt.options[0]?.label,
    ).toBe("Yes, and auto-accept edits");
  });

  it("reads the unboxed folder-trust prompt", () => {
    const prompt = detectPrompt(lines(folderTrust));
    expect(prompt?.kind).toBe("menu");
    if (prompt?.kind !== "menu") {
      throw new Error("not a menu");
    }
    expect(prompt.question).toBe("Do you trust the files in this folder?");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Yes, proceed",
      "No, exit",
    ]);
  });

  it("reads a y/N confirm from a plain CLI", () => {
    const prompt = detectPrompt(lines(confirmYn));
    expect(prompt?.kind).toBe("confirm");
    expect(prompt?.kind === "confirm" && prompt.question).toBe("Continue? (y/N)");

    const bracketed = detectPrompt(lines(confirmYesNo));
    expect(bracketed?.kind).toBe("confirm");
    expect(bracketed?.kind === "confirm" && bracketed.question).toBe(
      "Are you sure you want to continue? [y/n]",
    );
  });

  it("stays silent on ordinary output", () => {
    for (const [name, fixture] of Object.entries({
      negativeBuildLog,
      negativeShellPrompt,
      negativeTestSummary,
      negativeAgentOutput,
      negativeFailuresHeader,
    })) {
      expect(detectPrompt(lines(fixture)), name).toBeNull();
    }
    expect(detectPrompt([])).toBeNull();
    expect(detectPrompt(["", "   ", ""])).toBeNull();
  });

  it("falls back to unknown when the tail asks for something it cannot classify", () => {
    const prompt = detectPrompt([
      "Restoring the workspace…",
      "",
      "Enter the profile name to use:",
    ]);
    expect(prompt?.kind).toBe("unknown");
    expect(prompt?.raw.at(-1)).toBe("Enter the profile name to use:");
  });

  it("keeps only the last dozen non-empty lines in an unknown card", () => {
    const noise = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const prompt = detectPrompt([...noise, "", "Select an option to continue:"]);
    expect(prompt?.kind).toBe("unknown");
    expect(prompt?.raw).toHaveLength(12);
    expect(prompt?.raw.at(-1)).toBe("Select an option to continue:");
    expect(prompt?.raw.at(0)).toBe("line 29");
  });

  it("reads the live /model picker through its key-hint footer", () => {
    // Transcribed from a live claude on 2026-08-19: the option run does NOT
    // end the screen — an effort row and a keys row are drawn under it.
    const prompt = detectPrompt([
      "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
      "   Select model",
      "   Switch between Claude models. Your pick becomes the default for new sessions. For",
      "   other/previous model names, specify with --model.",
      "     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks",
      "   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks",
      "     3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks",
      "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
      "     5. Haiku                  Haiku 4.5 · Fastest for quick answers",
      "   ● High effort (default) ←/→ to adjust",
      "   Enter to set as default · s to use this session only · Esc to cancel",
    ]);
    expect(prompt?.kind).toBe("menu");
    if (prompt?.kind !== "menu") {
      return;
    }
    expect(prompt.options).toHaveLength(5);
    expect(prompt.selectedIndex).toBe(1);
    expect(prompt.options[1]?.label).toContain("Opus (1M context)");
  });
});

describe("keysForMenuAnswer", () => {
  it("walks the selector down and confirms", () => {
    expect(keysForMenuAnswer({ selectedIndex: 0 }, 2)).toBe("\x1b[B\x1b[B\r");
  });

  it("walks the selector up and confirms", () => {
    expect(keysForMenuAnswer({ selectedIndex: 3 }, 1)).toBe("\x1b[A\x1b[A\r");
  });

  it("sends only Enter when the wanted option is already selected", () => {
    expect(keysForMenuAnswer({ selectedIndex: 1 }, 1)).toBe("\r");
  });
});
