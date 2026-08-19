/**
 * The slash command cache, and how it teaches itself (chat v3 spec §2).
 *
 * The palette must open instantly, so it draws from a cache — and the cache
 * must never go stale, so claude itself is the teacher: every time the palette
 * opens, a "/" goes to the hidden session, claude draws its own full menu into
 * the buffer, and this module reads that menu back out. One use behind at
 * worst, and no list in this repo ever needs hand-patching again.
 *
 * Three rules keep a bad screen from poisoning the cache. Rows only count in
 * the block HUGGING the input box that is visibly holding our "/"
 * (`MENU_ANCHOR`) — output that merely looks like a menu is separated from
 * the box by its own prose. A parse of fewer than `MIN_MENU_ROWS` rows is
 * discarded outright — that is noise, not a menu. And merging is upsert-only:
 * claude's menu scrolls, so a row that is not on screen proves nothing about
 * whether the command exists.
 */

import { DETECT_INTERVAL_MS, type ScheduleFn } from "./promptWatcher";

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * claude's built-ins as of v2.1.235, so the palette is useful the very first
 * time it is opened on a machine that has never learned anything. The first
 * real learn overwrites these descriptions in place; nothing here is ever
 * deleted, because a seed that claude stopped drawing is still one keystroke
 * the user might want.
 */
export const SEED_COMMANDS: readonly SlashCommand[] = [
  { name: "add-dir", description: "Add a working directory to the session" },
  { name: "agents", description: "Manage agent configurations" },
  { name: "bashes", description: "List and manage background shells" },
  { name: "bug", description: "Report a bug to Anthropic" },
  { name: "clear", description: "Clear the conversation and free context" },
  { name: "compact", description: "Summarize the conversation to free context" },
  { name: "config", description: "Open the config panel" },
  { name: "context", description: "Show current context usage as a grid" },
  { name: "cost", description: "Show cost and duration of this session" },
  { name: "doctor", description: "Diagnose the installation and settings" },
  { name: "exit", description: "Exit the session" },
  { name: "export", description: "Export the conversation to a file or clipboard" },
  { name: "help", description: "Show help and available commands" },
  { name: "hooks", description: "Manage hook configurations for tool events" },
  { name: "ide", description: "Manage IDE integrations and show status" },
  { name: "init", description: "Create a CLAUDE.md describing the codebase" },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repo" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out of your Anthropic account" },
  { name: "mcp", description: "Manage MCP servers and connections" },
  { name: "memory", description: "Edit the memory files" },
  { name: "migrate-installer", description: "Move to the local installer" },
  { name: "model", description: "Set the AI model for this session" },
  { name: "output-style", description: "Set the output style" },
  { name: "permissions", description: "Manage allow and deny tool permission rules" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
  { name: "release-notes", description: "View the release notes" },
  { name: "rename", description: "Rename the current conversation" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "review", description: "Review a pull request" },
  { name: "rewind", description: "Rewind the conversation and/or the code" },
  { name: "sandbox", description: "Manage sandbox settings and status" },
  { name: "settings", description: "Open the settings panel" },
  { name: "status", description: "Show version, model and account status" },
  { name: "statusline", description: "Set up the status line UI" },
  { name: "terminal-setup", description: "Bind Shift+Enter to a newline here" },
  { name: "todos", description: "List the current todo items" },
  { name: "upgrade", description: "Upgrade for higher rate limits" },
  { name: "vim", description: "Toggle between Vim and Normal editing modes" },
];

/**
 * Below this a "menu" is a coincidence. Two, not three: a live claude on a
 * busy screen draws as few as two (most-recently-used) rows, and the anchor
 * plus the contiguity walk — not the row count — are what keep lookalike
 * output out of the cache now.
 */
export const MIN_MENU_ROWS = 2;

/**
 * Box-drawing chrome, copied from `idleDetector.ts` rather than imported: that
 * module's framing rules serve its own idle question, and a menu row must not
 * change shape because idle detection was tuned.
 */
const BOX_EDGE = /^[╭╰╞╡├┤┌└╔╚┏┗│┃║]+|[│┃║╮╯┐┘╗╝┓┛]+$/g;
const BOX_ONLY = /^[\s─━═╌╍│┃║╭╮╰╯┌┐└┘╔╗╚╝┏┓┗┛├┤┬┴┼]*$/;

/**
 * One menu row: an optional selector glyph, `/name`, an optional argument
 * hint or scope tag, then two or more spaces and the description. The hint
 * group is LAZY (`??`) so a description that happens to contain a double
 * space is still read whole — the hint is only considered when the plain
 * shape cannot match at all.
 */
const MENU_ROW = /^\s*(?:[❯›▸>]\s+)?\/([A-Za-z][\w:-]*)(?:\s+\S[^\s].*?)??\s{2,}(\S.*)$/;

/**
 * Wrapped descriptions put a plain continuation line between rows, and one
 * separator sits between the menu and the box. A run of non-row lines longer
 * than this means the menu has ended and everything further is output.
 */
const MAX_ROW_GAP = 2;

/** A line with its frame removed; a line that is ONLY frame reads as blank. */
function strip(line: string): string {
  const bare = line.replace(/\r/g, "");
  if (BOX_ONLY.test(bare)) {
    return "";
  }
  return bare.replace(BOX_EDGE, "").trim();
}

/**
 * The input box holding exactly the "/" the overlay sent — the proof that the
 * rows below it are claude drawing its menu. Without this anchor, three lines
 * of ordinary OUTPUT that merely look like menu rows (an answer about slash
 * commands, a file listing) would teach a cache that never deletes.
 */
const MENU_ANCHOR = /^[>❯›]\s*\/$/;

/** Read claude's own command menu off the screen. `[]` = nothing trustworthy. */
export function parseSlashMenu(visibleLines: string[]): SlashCommand[] {
  // The LAST anchor is the live input box; earlier ones are scrollback.
  let anchorIndex = -1;
  for (let index = 0; index < visibleLines.length; index += 1) {
    if (MENU_ANCHOR.test(strip(visibleLines[index] ?? ""))) {
      anchorIndex = index;
    }
  }
  if (anchorIndex === -1) {
    return [];
  }

  // The menu HUGS the box: live capture (2026-08-19) shows claude drawing it
  // ABOVE the box when the box sits at the bottom of a full screen, and below
  // it when there is room. Walk both ways from the anchor, tolerating the
  // short runs of plain lines that wrapped descriptions and separators make,
  // and stopping once the run says the menu has ended.
  const menuTexts: string[] = [];
  const walkTexts = (step: number): string[] => {
    const collected: string[] = [];
    let gap = 0;
    for (
      let index = anchorIndex + step;
      index >= 0 && index < visibleLines.length;
      index += step
    ) {
      const text = strip(visibleLines[index] ?? "");
      if (text.length === 0) {
        continue; // frames and separators say nothing either way
      }
      if (MENU_ROW.test(text)) {
        collected.push(text);
        gap = 0;
        continue;
      }
      gap += 1;
      if (gap > MAX_ROW_GAP) {
        break;
      }
    }
    return collected;
  };
  menuTexts.push(...walkTexts(-1).reverse(), ...walkTexts(1));

  const rows: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const text of menuTexts) {
    const match = MENU_ROW.exec(text);
    if (match === null) {
      continue;
    }
    const name = match[1] ?? "";
    const description = (match[2] ?? "").trim();
    if (name.length === 0 || description.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    rows.push({ name, description });
  }
  return rows.length >= MIN_MENU_ROWS ? rows : [];
}

/**
 * Fold a learn into the cache. Upsert by name, NEVER delete: the menu is
 * scrollable and a single screen only ever shows part of it. Existing entries
 * keep their position (the palette's order stops jumping under the user) and
 * genuinely new ones land alphabetically at the end.
 *
 * The same reference comes back when nothing changed, because this runs on
 * every sample while the palette is open and an unchanged learn must not
 * schedule a ui-state save.
 */
export function mergeCommands(
  cache: readonly SlashCommand[],
  learned: readonly SlashCommand[],
): readonly SlashCommand[] {
  if (learned.length === 0) {
    return cache;
  }
  const updates = new Map<string, SlashCommand>();
  for (const command of learned) {
    if (!updates.has(command.name)) {
      updates.set(command.name, command);
    }
  }
  let changed = false;
  const merged = cache.map((entry) => {
    const update = updates.get(entry.name);
    if (update === undefined || update.description === entry.description) {
      return entry;
    }
    changed = true;
    return { name: entry.name, description: update.description };
  });
  const known = new Set(cache.map((entry) => entry.name));
  const additions = [...updates.values()]
    .filter((command) => !known.has(command.name))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  if (additions.length === 0) {
    return changed ? merged : cache;
  }
  return [...merged, ...additions];
}

/**
 * Rank the cache against what the user has typed so far (no leading "/").
 * Name prefixes first — that is what someone typing a command means — then
 * names that merely contain it, then descriptions, each alphabetical so the
 * list is stable between keystrokes. An empty query is the whole cache in
 * cache order.
 */
export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...commands];
  }
  const prefixed: SlashCommand[] = [];
  const inName: SlashCommand[] = [];
  const inDescription: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefixed.push(command);
    } else if (name.includes(needle)) {
      inName.push(command);
    } else if (command.description.toLowerCase().includes(needle)) {
      inDescription.push(command);
    }
  }
  const byName = (left: SlashCommand, right: SlashCommand) =>
    left.name < right.name ? -1 : 1;
  return [
    ...prefixed.sort(byName),
    ...inName.sort(byName),
    ...inDescription.sort(byName),
  ];
}

export interface SlashLearnerOptions {
  /** The pane's visible terminal lines, newest sample each call. */
  snapshot(): string[];
  /** Called with every parse worth keeping; merging is the caller's job. */
  onLearned(commands: SlashCommand[]): void;
  schedule?: ScheduleFn;
}

export interface SlashLearner {
  start(): void;
  stop(): void;
  dispose(): void;
}

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/**
 * Watch the hidden session for claude's command menu while the palette is
 * open. It only ever READS — the "/" that makes claude draw the menu is sent
 * by the overlay, deliberately, as part of opening the palette.
 */
export function createSlashLearner(options: SlashLearnerOptions): SlashLearner {
  const schedule = options.schedule ?? defaultSchedule;
  let cancel: (() => void) | null = null;
  let disposed = false;

  const arm = () => {
    // `DETECT_INTERVAL_MS` is read here rather than at module scope: once
    // `ChatInput` imports this module the import graph is a cycle, and a
    // top-level read of another module's const in a cycle is a TDZ crash.
    cancel = schedule(() => {
      cancel = null;
      const learned = parseSlashMenu(options.snapshot());
      if (learned.length > 0) {
        options.onLearned(learned);
      }
      arm();
    }, DETECT_INTERVAL_MS);
  };

  return {
    start() {
      if (disposed || cancel !== null) {
        return;
      }
      arm();
    },
    stop() {
      cancel?.();
      cancel = null;
    },
    dispose() {
      disposed = true;
      cancel?.();
      cancel = null;
    },
  };
}
