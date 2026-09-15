/**
 * The same invariant as `state/__tests__/paneTitleFuzz.test.ts`, one layer up:
 * a pane's name must survive the trip through the writer as well as through
 * the layout algebra.
 *
 * Two windows share one layout. Only the main window writes to the daemon; a
 * second window proposes its changes and adopts what main broadcasts back. A
 * name typed in either window has to end up in BOTH windows and in the blob
 * that was actually written — and randomized sequences are the only way to
 * check that for orderings nobody thought to write down.
 *
 * Changes are made one at a time and allowed to settle, so no proposal is ever
 * a genuine conflict: every step here MUST land, and a conflict notice is a
 * failure, not an expected outcome.
 */
import { describe, expect, it, vi } from "vitest";
import { emptyLayout, type Layout, type SplitNode } from "../../state/layout";
import { createLayoutStore } from "../../state/store";
import { LayoutPersistence } from "../LayoutPersistence";
import { auxiliaryLayoutSync, mainLayoutSync } from "../layoutSync";
import { paneTitleInSplit } from "../layoutOperations";
import { loopbackBus } from "../windowBus";
import { mulberry32 } from "../../state/__tests__/helpers";

/// Two tabs, four panes: one tab whose nested split is on the left and one
/// whose nested split is on the right.
function shared(): Layout {
  const pane = (sessionId: number): SplitNode => ({ kind: "pane", sessionId });
  const layout = emptyLayout();
  layout.tabs = {
    left: {
      id: "left",
      title: "Amy Kittle",
      color: "cyan",
      fill: "off",
      split: {
        kind: "split",
        dir: "row",
        sizes: [0.6, 0.4],
        children: [
          { kind: "split", dir: "row", sizes: [0.43, 0.57], children: [pane(1), pane(2)] },
          pane(3),
        ],
      },
    },
    right: {
      id: "right",
      title: "Kittle Stuff",
      color: "magenta",
      fill: "off",
      split: {
        kind: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [pane(4), { kind: "split", dir: "col", sizes: [0.5, 0.5], children: [pane(5), pane(6)] }],
      },
    },
  };
  layout.rootItems = [{ kind: "tab", id: "left" }, { kind: "tab", id: "right" }];
  layout.activeTabId = "left";
  return layout;
}

const NAMES = ["Blogs", "SEO", "Build", "Server", "Tests", "Plan"];
const TAB_OF: Record<number, "left" | "right"> = {
  1: "left", 2: "left", 3: "left", 4: "right", 5: "right", 6: "right",
};

describe("a pane name typed in either window reaches both windows and the daemon", () => {
  it("holds across 120 random two-window rename sequences", async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = mulberry32(seed);
      const bus = loopbackBus();
      const mainStore = createLayoutStore(shared());
      const auxStore = createLayoutStore(shared());
      // What is on disk at boot; a rename that changes nothing writes nothing,
      // so the last blob written is not always this step's.
      const written: Layout[] = [shared()];
      const conflicts = vi.fn();
      const main = mainLayoutSync(mainStore, bus, (layout) => { written.push(layout); });
      const aux = auxiliaryLayoutSync(auxStore, bus, conflicts);
      bus.onMutation(main.receive);
      bus.onLayout(aux.receive);
      const auxPersistence = new LayoutPersistence(aux);
      const expected = new Map<number, string | undefined>();
      const trail: string[] = [];

      for (let step = 0; step < 14; step++) {
        const sessionId = 1 + Math.floor(random() * 6);
        const clear = random() < 0.25;
        const name = clear ? null : NAMES[Math.floor(random() * NAMES.length)]!;
        const inAux = random() < 0.5;

        if (inAux) {
          auxStore.renamePane(sessionId, name);
          auxPersistence.record(auxStore.getState(), "structural");
          await auxPersistence.flush();
        } else {
          mainStore.renamePane(sessionId, name);
          written.push(mainStore.getState());
          await main.broadcast();
        }
        expected.set(sessionId, name ?? undefined);
        trail.push(`${inAux ? "aux" : "main"}: renamePane(${sessionId}, ${JSON.stringify(name)})`);

        const context = `seed ${seed}\n  ${trail.join("\n  ")}`;
        for (const [label, store] of [["main", mainStore], ["aux", auxStore]] as const) {
          for (const [id, title] of expected) {
            expect(
              paneTitleInSplit(store.getState().tabs[TAB_OF[id]!]!.split, id),
              `${context}\n  ${label} window lost pane ${id}'s name`,
            ).toBe(title);
          }
        }
        const saved = written.at(-1)!;
        for (const [id, title] of expected) {
          expect(
            paneTitleInSplit(saved.tabs[TAB_OF[id]!]!.split, id),
            `${context}\n  the written blob lost pane ${id}'s name`,
          ).toBe(title);
        }
        expect(conflicts, context).not.toHaveBeenCalled();
      }

      auxPersistence.dispose();
      aux.dispose();
    }
  });
});
