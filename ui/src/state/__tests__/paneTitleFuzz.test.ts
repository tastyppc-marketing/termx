/**
 * A pane's name is the user's, and nothing the layout does to that pane may
 * take it away.
 *
 * Michael reported the same loss three times (2026-09-15: "Window pane name
 * saving is still not working... test and keep testing until it's verifiably
 * unable to break"). Example-based tests only cover the sequences someone
 * thought of; the ways a name can vanish are sequences nobody thought of — a
 * pane rebuilt by a split, a tab merged into another, a session swapped in
 * place, a blob round-tripped through the daemon.
 *
 * So this is the invariant, checked after EVERY operation of a few hundred
 * random sequences: each pane still in the layout carries exactly the title it
 * was last given, and the serialized blob parses back to the same layout. The
 * generator is a hand-rolled seeded PRNG — the failing seed is printed, and
 * re-running it replays the exact sequence.
 */
import { describe, expect, it } from "vitest";
import {
  emptyLayout,
  parseLayout,
  serializeLayout,
  validateInvariants,
  type Layout,
  type SplitNode,
  type Tab,
} from "../layout";
import { createLayoutStore } from "../store";
import { mulberry32, paneTitlesOf } from "./helpers";
import {
  extractSessionToTab,
  mergeTabIntoTab,
  paneTitleInSplit,
  replaceSessionInTab,
  sessionIdsInTab,
} from "../../workspace/layoutOperations";

function panesOf(node: SplitNode, out: number[] = []): number[] {
  if (node.kind === "pane") {
    out.push(node.sessionId);
    return out;
  }
  panesOf(node.children[0], out);
  panesOf(node.children[1], out);
  return out;
}

function allPanes(layout: Layout): number[] {
  return Object.values(layout.tabs).flatMap((tab) => panesOf(tab.split));
}

function tabOfSession(layout: Layout, sessionId: number): Tab | undefined {
  return Object.values(layout.tabs).find((tab) => panesOf(tab.split).includes(sessionId));
}

const NAMES = ["Blogs", "SEO", "Build", "Server", "Tests", "Plan", "Amy Kittle", "notes"];

describe("a pane keeps its name through any sequence of layout operations", () => {
  const SEQUENCES = 240;
  const STEPS = 24;

  it(`holds every pane's name across ${SEQUENCES} random sequences`, { timeout: 30_000 }, () => {
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T | undefined =>
        items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

      // Start from a workspace with the shapes that matter: a lone pane, a
      // split whose nested half is on the LEFT (Michael's "Amy Kittle" tab)
      // and one whose nested half is on the RIGHT (his "Kittle Stuff" tab).
      const store = createLayoutStore(seedLayout());
      /// The model: what each session's pane was last NAMED. Session ids
      /// follow a restart in place, so the entry moves with the pane.
      const expected = new Map<number, string | undefined>();
      for (const sessionId of allPanes(store.getState())) {
        expected.set(sessionId, paneTitleInSplit(
          tabOfSession(store.getState(), sessionId)!.split,
          sessionId,
        ));
      }
      let nextSessionId = 100;
      let nextId = 0;
      const freshId = () => `f${seed}-${nextId++}`;
      const trail: string[] = [];

      const check = (step: string) => {
        trail.push(step);
        const layout = store.getState();
        const context = `seed ${seed}\n  ${trail.join("\n  ")}`;
        expect(validateInvariants(layout), context).toEqual([]);
        // Nothing may name a pane that the model never named, and nothing may
        // rename or unname one behind the user's back.
        for (const [sessionId, title] of paneTitlesOf(layout)) {
          expect(
            { sessionId, title },
            `${context}\n  pane ${sessionId} lost or changed its name`,
          ).toEqual({ sessionId, title: expected.get(sessionId) });
        }
        // What reaches the daemon is what comes back from it.
        const round = parseLayout(serializeLayout(layout));
        expect(round, `${context}\n  the blob did not parse back`).not.toBeNull();
        expect(round, `${context}\n  the blob changed on the round trip`).toEqual(layout);
      };

      check("start");

      for (let step = 0; step < STEPS; step++) {
        const layout = store.getState();
        const panes = allPanes(layout);
        const tabIds = Object.keys(layout.tabs);
        const sessionId = pick(panes);
        const tabId = pick(tabIds);
        const roll = Math.floor(random() * 12);

        if (sessionId === undefined || tabId === undefined) {
          break;
        }

        switch (roll) {
          case 0:
          case 1: {
            // Name a pane (the operation everything else must not undo).
            const name = pick(NAMES)!;
            store.renamePane(sessionId, name);
            if (tabOfSession(layout, sessionId)) {
              expected.set(sessionId, name);
            }
            check(`renamePane(${sessionId}, ${JSON.stringify(name)})`);
            break;
          }
          case 2: {
            // Clear a name: back to the derived one, and nothing else moves.
            store.renamePane(sessionId, random() < 0.5 ? null : "   ");
            expected.set(sessionId, undefined);
            check(`renamePane(${sessionId}, null)`);
            break;
          }
          case 3: {
            const owner = tabOfSession(layout, sessionId)!;
            const created = nextSessionId++;
            const before = store.getState();
            const after = store.splitPane(owner.id, sessionId, random() < 0.5 ? "row" : "col", created);
            if (after !== before) {
              expected.set(created, undefined);
            }
            check(`splitPane(${owner.id}, ${sessionId}, ${created})`);
            break;
          }
          case 4: {
            const owner = tabOfSession(layout, sessionId)!;
            store.closePane(owner.id, sessionId);
            expected.delete(sessionId);
            check(`closePane(${owner.id}, ${sessionId})`);
            break;
          }
          case 5: {
            // Restart in place: the terminal is new, the pane and its name
            // are the same pane and the same name.
            const owner = tabOfSession(layout, sessionId)!;
            const replacement = nextSessionId++;
            const replaced = replaceSessionInTab(layout, owner.id, sessionId, replacement);
            if (replaced) {
              store.replaceState(replaced);
              expected.set(replacement, expected.get(sessionId));
              expected.delete(sessionId);
            }
            check(`replaceSessionInTab(${owner.id}, ${sessionId} -> ${replacement})`);
            break;
          }
          case 6: {
            const other = pick(tabIds.filter((id) => id !== tabId));
            if (other !== undefined) {
              const merged = mergeTabIntoTab(layout, other, tabId);
              if (merged) {
                store.replaceState(merged);
              }
              check(`mergeTabIntoTab(${other} -> ${tabId})`);
            }
            break;
          }
          case 7: {
            const owner = tabOfSession(layout, sessionId)!;
            if (sessionIdsInTab(owner).length > 1) {
              const extracted = extractSessionToTab(layout, owner.id, sessionId, freshId());
              if (extracted) {
                store.replaceState(extracted);
              }
              check(`extractSessionToTab(${owner.id}, ${sessionId})`);
            }
            break;
          }
          case 8: {
            // Between windows, and back: an aux slot is a different container,
            // not a different layout.
            const windowId = random() < 0.5 ? "aux-1" : "aux-2";
            store.moveItemToWindow({ kind: "tab", id: tabId }, windowId);
            check(`moveItemToWindow(${tabId}, ${windowId})`);
            if (random() < 0.5) {
              store.returnWindowToMain(windowId);
              check(`returnWindowToMain(${windowId})`);
            }
            break;
          }
          case 9: {
            const groupIds = Object.keys(layout.groups);
            const groupId = pick(groupIds);
            if (groupId !== undefined && random() < 0.5) {
              store.moveTab(tabId, { groupId }, Math.floor(random() * 3));
              check(`moveTab(${tabId} -> group ${groupId})`);
            } else {
              const created = freshId();
              store.createGroup({ id: created, name: `g${created}` });
              store.moveTab(tabId, { groupId: created }, 0);
              check(`createGroup(${created}) + moveTab(${tabId})`);
            }
            break;
          }
          case 10: {
            // A whole trip through the daemon: serialize, parse, adopt.
            const parsed = parseLayout(serializeLayout(layout));
            expect(parsed, `seed ${seed}: the layout stopped parsing`).not.toBeNull();
            store.replaceState(parsed!);
            check("save + reload");
            break;
          }
          default: {
            const owner = tabOfSession(layout, sessionId)!;
            if (owner.split.kind === "split") {
              store.resizePane(owner.id, [], [random(), random()]);
              check(`resizePane(${owner.id})`);
            } else {
              store.setActiveTab(tabId);
              check(`setActiveTab(${tabId})`);
            }
            break;
          }
        }
      }
    }
  });
});

/// Three tabs: a lone pane, a split nested on the LEFT, a split nested on the
/// RIGHT — the two shapes Michael's own workspace holds, one of which had kept
/// its pane names and one of which had not.
function seedLayout(): Layout {
  const layout = emptyLayout();
  const pane = (sessionId: number, title?: string): SplitNode =>
    title === undefined ? { kind: "pane", sessionId } : { kind: "pane", sessionId, title };
  layout.tabs = {
    lone: {
      id: "lone",
      title: "Cerebras setup",
      color: "blue",
      fill: "off",
      split: pane(1),
    },
    "nested-left": {
      id: "nested-left",
      title: "Amy Kittle",
      color: "cyan",
      fill: "strong",
      split: {
        kind: "split",
        dir: "row",
        sizes: [0.6, 0.4],
        children: [
          {
            kind: "split",
            dir: "row",
            sizes: [0.43, 0.57],
            children: [pane(2), pane(3)],
          },
          pane(4),
        ],
      },
    },
    "nested-right": {
      id: "nested-right",
      title: "Kittle Stuff",
      color: "magenta",
      fill: "off",
      split: {
        kind: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          pane(5, "Blogs"),
          {
            kind: "split",
            dir: "row",
            sizes: [0.54, 0.46],
            children: [pane(6, "SEO"), pane(7, "SEO")],
          },
        ],
      },
    },
  };
  layout.groups = {
    clients: { id: "clients", name: "CLIENTS", collapsed: false, color: null, items: [] },
  };
  layout.rootItems = [
    { kind: "group", id: "clients" },
    { kind: "tab", id: "lone" },
    { kind: "tab", id: "nested-left" },
    { kind: "tab", id: "nested-right" },
  ];
  layout.activeTabId = "nested-left";
  return layout;
}
