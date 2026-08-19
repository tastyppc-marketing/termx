// LANE-B STUB — replaced at merge; lane A must not commit changes beyond the frozen contract
/**
 * Minimal stand-in for lane B's slash subsystem, so lane A's suite can run
 * against the frozen contract before the real module exists. Every signature
 * here is verbatim from the plan's frozen-contracts block; the bodies are the
 * least behaviour lane A's tests need and carry no learning logic.
 */

import type { ScheduleFn } from "./promptWatcher";

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const SEED_COMMANDS: readonly SlashCommand[] = [
  { name: "model", description: "Choose the model for this session" },
  { name: "rename", description: "Rename this conversation" },
  { name: "resume", description: "Resume a past conversation" },
];

export function parseSlashMenu(_visibleLines: string[]): SlashCommand[] {
  return [];
}

export function mergeCommands(
  cache: readonly SlashCommand[],
  learned: readonly SlashCommand[],
): readonly SlashCommand[] {
  if (learned.length === 0) {
    return cache;
  }
  const byName = new Map(cache.map((command) => [command.name, command]));
  for (const command of learned) {
    byName.set(command.name, command);
  }
  return [...byName.values()];
}

export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  if (query.length === 0) {
    return [...commands];
  }
  const needle = query.toLowerCase();
  const byName = (left: SlashCommand, right: SlashCommand) =>
    left.name.localeCompare(right.name);
  const prefix = commands.filter((command) =>
    command.name.toLowerCase().startsWith(needle),
  );
  const substring = commands.filter(
    (command) =>
      !command.name.toLowerCase().startsWith(needle) &&
      command.name.toLowerCase().includes(needle),
  );
  const described = commands.filter(
    (command) =>
      !command.name.toLowerCase().includes(needle) &&
      command.description.toLowerCase().includes(needle),
  );
  return [
    ...prefix.sort(byName),
    ...substring.sort(byName),
    ...described.sort(byName),
  ];
}

export function createSlashLearner(_options: {
  snapshot(): string[];
  onLearned(commands: SlashCommand[]): void;
  schedule?: ScheduleFn;
}): { start(): void; stop(): void; dispose(): void } {
  return {
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
  };
}
