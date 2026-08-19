/**
 * The slash command cache, its parser and its learner (chat v3 spec §2).
 *
 * The parser fixture is a transcription of a real claude v2.1.235 screen with
 * the menu open, box chrome included — that screen IS the teaching sample, so
 * the tests are only worth anything if they read the same shapes claude draws:
 * padded name column, argument hints, `(user)` tags on custom commands.
 */

import { describe, expect, it } from "vitest";
import {
  createSlashLearner,
  filterCommands,
  mergeCommands,
  parseSlashMenu,
  SEED_COMMANDS,
  type SlashCommand,
} from "../slashCommands";
import { DETECT_INTERVAL_MS, type ScheduleFn } from "../promptWatcher";

/** A hand-driven clock so every sample is a deliberate step. */
function testScheduler() {
  const pending = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  let now = 0;
  const schedule: ScheduleFn = (callback, delayMs) => {
    const id = nextId++;
    pending.set(id, { at: now + delayMs, run: callback });
    return () => {
      pending.delete(id);
    };
  };
  return {
    schedule,
    get pendingCount() {
      return pending.size;
    },
    advance(delayMs: number) {
      now += delayMs;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
  };
}

/**
 * claude v2.1.235 with "/" typed: the input box on top, the command menu
 * framed under it, the key hints in the footer. Transcribed verbatim apart
 * from the box width, which is narrowed to keep the file readable.
 */
const MENU_SCREEN = [
  "✻ Brewed for 4s",
  "",
  "╭────────────────────────────────────────────────────────────────╮",
  "│ > /                                                            │",
  "╰────────────────────────────────────────────────────────────────╯",
  "╭────────────────────────────────────────────────────────────────╮",
  "│   /add-dir               Add a new working directory           │",
  "│   /agents                Manage agent configurations           │",
  "│   /bashes                List and manage background tasks      │",
  "│   /clear                 Clear conversation history            │",
  "│   /compact [instr]       Clear history but keep a summary      │",
  "│   /config                Open config panel                     │",
  "│   /model                 Set the AI model for this session     │",
  "│   /output-style          Set the output style directly         │",
  "│   /pr-comments           Get comments from a GitHub PR         │",
  "│   /commit (user)         Create a git commit                   │",
  "│   /handoff (project)     Save session state for later          │",
  "╰────────────────────────────────────────────────────────────────╯",
  "  ↑/↓ to select · Enter to confirm · Esc to cancel",
];

/** An ordinary working screen: nothing here is a command list. */
const NOISY_SCREEN = [
  "$ npm run build",
  "",
  "> termx-ui@0.1.0 build",
  "> tsc --noEmit -p tsconfig.app.json && vite build",
  "",
  "vite v8.1.5 building for production...",
  "transforming...",
  "✓ 214 modules transformed.",
  "dist/index.html                    0.46 kB │ gzip:  0.30 kB",
  "dist/assets/index-DiwrgTda.css    12.34 kB │ gzip:  3.21 kB",
  "dist/assets/index-B7kQz1aP.js    284.71 kB │ gzip: 91.08 kB",
  "✓ built in 2.31s",
  "  /usr/local/share/termx  is on the path",
  "❯",
];

const RANK_SAMPLE: readonly SlashCommand[] = [
  { name: "zebra", description: "nothing to do with it" },
  { name: "companion", description: "Pair with another session" },
  { name: "compact", description: "Summarize the conversation" },
  { name: "recompact", description: "Do it again" },
  { name: "clear", description: "Clear the compacted history" },
];

describe("SEED_COMMANDS", () => {
  it("ships claude's built-ins, bare-named and alphabetical", () => {
    const names = SEED_COMMANDS.map((command) => command.name);
    expect(names).toContain("model");
    expect(names).toContain("resume");
    expect(names).toContain("install-github-app");
    expect(names.some((name) => name.startsWith("/"))).toBe(false);
    expect([...names]).toEqual([...names].sort());
    // Descriptions are one line in a narrow palette row.
    for (const command of SEED_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("parseSlashMenu", () => {
  it("reads a real claude menu screen through its box chrome", () => {
    const parsed = parseSlashMenu(MENU_SCREEN);
    expect(parsed.slice(0, 4)).toEqual([
      { name: "add-dir", description: "Add a new working directory" },
      { name: "agents", description: "Manage agent configurations" },
      { name: "bashes", description: "List and manage background tasks" },
      { name: "clear", description: "Clear conversation history" },
    ]);
    expect(parsed).toHaveLength(11);
  });

  it("keeps the bare name when the row carries an argument hint or a scope tag", () => {
    const byName = new Map(
      parseSlashMenu(MENU_SCREEN).map((command) => [command.name, command.description]),
    );
    expect(byName.get("compact")).toBe("Clear history but keep a summary");
    expect(byName.get("commit")).toBe("Create a git commit");
    expect(byName.get("handoff")).toBe("Save session state for later");
    expect(byName.has("compact [instr]")).toBe(false);
  });

  it("takes nothing from the input box, the frame or the key hints", () => {
    const names = parseSlashMenu(MENU_SCREEN).map((command) => command.name);
    expect(names).not.toContain("");
    expect(names.every((name) => /^[A-Za-z][\w:-]*$/.test(name))).toBe(true);
  });

  it("learns nothing from a screen that is not a menu", () => {
    expect(parseSlashMenu(NOISY_SCREEN)).toEqual([]);
    expect(parseSlashMenu([])).toEqual([]);
  });

  it("discards a parse too small to be evidence", () => {
    // Two rows is what a half-drawn frame or a stray line looks like; the
    // cache is never allowed to learn from that.
    expect(
      parseSlashMenu([
        "> /",
        "  /model                 Set the AI model for this session",
        "  /clear                 Clear conversation history",
      ]),
    ).toEqual([]);
    expect(
      parseSlashMenu([
        "> /",
        "  /model                 Set the AI model for this session",
        "  /clear                 Clear conversation history",
        "  /cost                  Show the cost of this session",
      ]),
    ).toHaveLength(3);
  });

  it("learns nothing without the input box visibly holding the slash", () => {
    // These rows are perfect — but no box holds a bare "/", so they are
    // OUTPUT that happens to look like a menu (an answer about slash
    // commands, say). A cache that never deletes must not eat that.
    expect(
      parseSlashMenu([
        "  /model                 Set the AI model for this session",
        "  /clear                 Clear conversation history",
        "  /cost                  Show the cost of this session",
      ]),
    ).toEqual([]);
    // And rows ABOVE the box are scrollback, not the menu the box opened.
    expect(
      parseSlashMenu([
        "  /model                 Set the AI model for this session",
        "  /clear                 Clear conversation history",
        "  /cost                  Show the cost of this session",
        "> /",
      ]),
    ).toEqual([]);
  });

  it("keeps the first row when a name is drawn twice", () => {
    const parsed = parseSlashMenu([
      "> /",
      "  /model                 Set the AI model for this session",
      "  /clear                 Clear conversation history",
      "  /cost                  Show the cost of this session",
      "  /model                 Set the AI model for this session",
    ]);
    expect(parsed.filter((command) => command.name === "model")).toHaveLength(1);
  });
});

describe("mergeCommands", () => {
  it("returns the same reference when the learn changes nothing", () => {
    expect(mergeCommands(SEED_COMMANDS, [])).toBe(SEED_COMMANDS);
    expect(mergeCommands(SEED_COMMANDS, [...SEED_COMMANDS])).toBe(SEED_COMMANDS);
    const cache: readonly SlashCommand[] = [
      { name: "model", description: "Set the AI model for this session" },
    ];
    expect(
      mergeCommands(cache, [{ name: "model", description: "Set the AI model for this session" }]),
    ).toBe(cache);
  });

  it("overwrites a description in place, keeping cache order", () => {
    const cache: readonly SlashCommand[] = [
      { name: "model", description: "old" },
      { name: "clear", description: "Clear conversation history" },
    ];
    const merged = mergeCommands(cache, [{ name: "model", description: "new" }]);
    expect(merged).not.toBe(cache);
    expect(merged).toEqual([
      { name: "model", description: "new" },
      { name: "clear", description: "Clear conversation history" },
    ]);
  });

  it("appends unknown commands alphabetically after the cache", () => {
    const cache: readonly SlashCommand[] = [
      { name: "model", description: "Set the AI model" },
      { name: "clear", description: "Clear conversation history" },
    ];
    const merged = mergeCommands(cache, [
      { name: "rewind", description: "Rewind the conversation" },
      { name: "agents", description: "Manage agent configurations" },
      { name: "agents", description: "Manage agent configurations" },
    ]);
    expect(merged.map((command) => command.name)).toEqual([
      "model",
      "clear",
      "agents",
      "rewind",
    ]);
  });

  it("never deletes: claude's menu scrolls, so an absent row proves nothing", () => {
    const cache: readonly SlashCommand[] = [
      { name: "model", description: "Set the AI model" },
      { name: "clear", description: "Clear conversation history" },
      { name: "cost", description: "Show the cost of this session" },
    ];
    const merged = mergeCommands(cache, [{ name: "model", description: "Set the model" }]);
    expect(merged.map((command) => command.name)).toEqual(["model", "clear", "cost"]);
  });
});

describe("filterCommands", () => {
  it("returns everything, in cache order, for an empty query", () => {
    expect(filterCommands(RANK_SAMPLE, "")).toEqual([...RANK_SAMPLE]);
  });

  it("ranks name prefixes first, then name substrings, then descriptions", () => {
    expect(filterCommands(RANK_SAMPLE, "comp").map((command) => command.name)).toEqual([
      "compact",
      "companion",
      "recompact",
      "clear",
    ]);
  });

  it("ignores case", () => {
    expect(filterCommands(RANK_SAMPLE, "COMP")).toEqual(
      filterCommands(RANK_SAMPLE, "comp"),
    );
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(RANK_SAMPLE, "qqq")).toEqual([]);
  });

  it("takes the query without its leading slash", () => {
    const names = filterCommands(SEED_COMMANDS, "mod").map((command) => command.name);
    expect(names[0]).toBe("model");
  });
});

describe("createSlashLearner", () => {
  function build(screen: string[] = MENU_SCREEN) {
    const clock = testScheduler();
    const learned: SlashCommand[][] = [];
    let current = screen;
    const learner = createSlashLearner({
      snapshot: () => current,
      onLearned: (commands) => learned.push(commands),
      schedule: clock.schedule,
    });
    return {
      clock,
      learned,
      learner,
      setScreen(lines: string[]) {
        current = lines;
      },
    };
  }

  it("samples nothing until it is started", () => {
    const harness = build();
    harness.clock.advance(DETECT_INTERVAL_MS * 5);
    expect(harness.learned).toEqual([]);
    expect(harness.clock.pendingCount).toBe(0);
  });

  it("reports every accepted parse while it runs", () => {
    const harness = build();
    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS);
    expect(harness.learned).toHaveLength(1);
    expect(harness.learned[0]?.[0]).toEqual({
      name: "add-dir",
      description: "Add a new working directory",
    });
    harness.clock.advance(DETECT_INTERVAL_MS);
    expect(harness.learned).toHaveLength(2);
  });

  it("stays silent on a screen it could not read", () => {
    const harness = build(NOISY_SCREEN);
    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS * 4);
    expect(harness.learned).toEqual([]);
  });

  it("starts sampling once however many times it is started", () => {
    const harness = build();
    harness.learner.start();
    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS);
    expect(harness.learned).toHaveLength(1);
  });

  it("stops on demand and can run again", () => {
    const harness = build();
    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS);
    harness.learner.stop();
    expect(harness.clock.pendingCount).toBe(0);
    harness.clock.advance(DETECT_INTERVAL_MS * 3);
    expect(harness.learned).toHaveLength(1);

    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS);
    expect(harness.learned).toHaveLength(2);
  });

  it("never runs again once disposed", () => {
    const harness = build();
    harness.learner.start();
    harness.learner.dispose();
    expect(harness.clock.pendingCount).toBe(0);
    harness.learner.start();
    harness.clock.advance(DETECT_INTERVAL_MS * 3);
    expect(harness.learned).toEqual([]);
    expect(harness.clock.pendingCount).toBe(0);
  });
});
