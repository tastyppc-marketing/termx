/**
 * Density policy (chat-view spec §4): how much of a tool's body the chat opens
 * without being asked.
 *
 * `chips` shows nothing but the one-line chips, `full` opens everything, and
 * `smart` opens the three things that are almost always the reason someone
 * looks: a tool that failed, a file edit's diff, and a test run's output. The
 * predicates live here on purpose — they are the part that needs tuning as
 * habits change, and tuning them must never mean touching a component.
 */

import type { ChatDensity, ToolEntry } from "./types";

/** Tools whose result IS a diff. */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** A command that reads like a test run. */
const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|spec|specs)\b/i;

/** Output that reads like a test report, whoever produced it. */
const TEST_OUTPUT = /\bfailed\b|\bpassed\b/i;

export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

export function isTestRun(entry: ToolEntry): boolean {
  if (entry.name === "Bash" && TEST_COMMAND.test(entry.title)) {
    return true;
  }
  return TEST_OUTPUT.test(entry.detail);
}

/** Whether this chip starts expanded under `density`. */
export function isExpandedByDefault(entry: ToolEntry, density: ChatDensity): boolean {
  if (density === "full") {
    return true;
  }
  if (density === "chips") {
    return false;
  }
  if (entry.status === "error") {
    return true;
  }
  if (isEditTool(entry.name)) {
    return true;
  }
  return isTestRun(entry);
}
