import { describe, expect, it } from "vitest";
import {
  FILL_STRENGTHS,
  PALETTE_IDS,
  parseLayout,
  serializeLayout,
  sessionIdsInLayout,
  validateInvariants,
} from "../layout";
import type { LayoutV2, SplitNode } from "../layout";
import { createLayoutStore } from "../store";
import { baseLayout, mulberry32 } from "./helpers";

interface PaneRef {
  tabId: string;
  sessionId: number;
}

function panes(layout: LayoutV2): PaneRef[] {
  const out: PaneRef[] = [];
  for (const tab of Object.values(layout.tabs)) {
    const walk = (node: SplitNode): void => {
      if (node.kind === "pane") {
        out.push({ tabId: tab.id, sessionId: node.sessionId });
      } else {
        walk(node.children[0]);
        walk(node.children[1]);
      }
    };
    walk(tab.split);
  }
  return out;
}

function splitPaths(node: SplitNode, prefix: number[] = []): number[][] {
  if (node.kind === "pane") {
    return [];
  }
  return [
    prefix,
    ...splitPaths(node.children[0], [...prefix, 0]),
    ...splitPaths(node.children[1], [...prefix, 1]),
  ];
}

/// After ANY sequence of 50 random ops the invariants must hold. Ops draw
/// their arguments from the live state (so most are valid) with a sprinkle
/// of garbage (ghost ids, wild indices) that must be rejected, not corrupt.
describe("random op sequences keep every invariant", () => {
  it.each([[1], [42], [1337], [0xbeef], [20260723]])(
    "seed %d",
    (seed) => {
      const rand = mulberry32(seed);
      const rint = (n: number) => Math.floor(rand() * n);
      const pick = <T>(arr: readonly T[]): T | undefined => arr[rint(arr.length)];

      const store = createLayoutStore(baseLayout());
      let nextSession = 100;
      let nextId = 0;

      const groupList = (): string[] => Object.keys(store.getState().groups);

      const ops: Array<() => void> = [
        () => {
          const groups = groupList();
          const grouped = rand() < 0.3 && groups.length > 0;
          store.createTab({
            id: rand() < 0.9 ? `T${nextId++}` : "",
            sessionId: rand() < 0.9 ? nextSession++ : -1,
            groupId: grouped ? pick(groups) : null,
            index: rint(6) - 1,
            color: pick(PALETTE_IDS),
            title: rand() < 0.3 ? `tab ${rint(1000)}` : undefined,
          });
        },
        () => {
          store.closeTab(pick(Object.keys(store.getState().tabs)) ?? "ghost");
        },
        () => {
          const id = pick(Object.keys(store.getState().tabs)) ?? "ghost";
          store.renameTab(id, rand() < 0.2 ? null : `name ${rint(1000)}`);
        },
        () => {
          const id = pick(Object.keys(store.getState().tabs)) ?? "ghost";
          store.recolorTab(id, pick(PALETTE_IDS)!);
        },
        () => {
          const tabs = Object.keys(store.getState().tabs);
          store.setActiveTab(rand() < 0.1 ? null : pick(tabs) ?? "ghost");
        },
        () => {
          const state = store.getState();
          const tabId = pick(Object.keys(state.tabs)) ?? "ghost";
          const groupId = rand() < 0.5 ? pick(groupList()) ?? null : null;
          store.moveTab(tabId, { groupId }, rint(8) - 2);
        },
        () => {
          const groupId = rand() < 0.5 ? pick(groupList()) ?? null : null;
          store.reorderWithinContainer(groupId, rint(6), rint(6));
        },
        () => {
          store.createGroup({
            id: `G${nextId++}`,
            name: `group ${rint(100)}`,
            ...(rand() < 0.5 ? { parentGroupId: pick(groupList()) ?? null } : {}),
            index: rint(4),
          });
        },
        () => {
          // Nesting churn: any group into any container, cycles included —
          // the store must refuse the illegal ones, never corrupt.
          const groupId = pick(groupList()) ?? "ghost";
          const target = rand() < 0.8 ? pick(groupList()) ?? null : null;
          store.moveItem({ kind: "group", id: groupId }, target, rint(6) - 1);
        },
        () => {
          const id = pick(groupList()) ?? "ghost";
          store.renameGroup(id, rand() < 0.1 ? "" : `renamed ${rint(100)}`);
        },
        () => {
          store.recolorGroup(
            pick(groupList()) ?? "ghost",
            rand() < 0.3 ? null : pick(PALETTE_IDS)!,
          );
        },
        () => {
          store.setTabFill(
            pick(Object.keys(store.getState().tabs)) ?? "ghost",
            pick(FILL_STRENGTHS)!,
          );
        },
        () => {
          store.toggleGroupCollapsed(pick(groupList()) ?? "ghost");
        },
        () => {
          store.deleteGroup(pick(groupList()) ?? "ghost");
        },
        () => {
          const target = pick(panes(store.getState()));
          if (target) {
            store.splitPane(
              target.tabId,
              target.sessionId,
              rand() < 0.5 ? "row" : "col",
              rand() < 0.9 ? nextSession++ : target.sessionId,
            );
          }
        },
        () => {
          const target = pick(panes(store.getState()));
          if (target) {
            store.closePane(target.tabId, target.sessionId);
          }
        },
        () => {
          const state = store.getState();
          const tabId = pick(Object.keys(state.tabs));
          if (tabId) {
            const paths = splitPaths(state.tabs[tabId].split);
            store.resizePane(
              tabId,
              pick(paths) ?? [rint(2)],
              [rand(), rand()],
            );
          }
        },
      ];

      for (let step = 0; step < 50; step++) {
        pick(ops)!();
        const violations = validateInvariants(store.getState());
        expect(violations, `seed ${seed} step ${step}`).toEqual([]);
      }

      const final = store.getState();
      expect(parseLayout(serializeLayout(final))).toEqual(final);
      expect(new Set(sessionIdsInLayout(final)).size)
        .toBe(sessionIdsInLayout(final).length);
    },
  );
});
