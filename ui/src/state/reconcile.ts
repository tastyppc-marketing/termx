import { isPluginPaneId } from "../plugins/paneBindings";
import { sessionIdsInLayout } from "./layout";
import type { Item, Layout, Tab } from "./layout";

/// Boot-time reconciliation of the persisted layout against the host's actual
/// session list (spec "Restore reconciliation", rules 1–3).
///
/// Dead placeholders are represented OUT of band: panes referencing dead
/// sessions stay in the tree (they must render "session ended — Dismiss"
/// until the user dismisses them) and their session ids are reported in
/// `deadSessionIds`. No flag is added to the layout itself — the serialized
/// blob may only contain fields from the layout_v2 spec.
///
/// Structurally compatible with protocol SessionInfo.
export interface SessionLike {
  id: number;
  alive: boolean;
}

export interface ReconcileResult {
  layout: Layout;
  /// Session ids referenced by panes but not alive (absent host-side, or
  /// present with alive=false). Their panes render dead placeholders;
  /// Dismiss prunes the pane and CloseSessions ids still known to the host.
  deadSessionIds: number[];
  /// Live session ids that no tab referenced — each was adopted into a new
  /// one-pane root-level slate tab at tail position (rule 2). With a
  /// malformed/absent layout (rule 3) every live session lands here.
  orphanAdoptedIds: number[];
  /// Dead host-side sessions referenced by NO pane: invisible, but their
  /// scrollback rings still hold host memory. Candidates for CloseSession.
  /// (Addition beyond the spec's rules; purely advisory.)
  unreferencedDeadSessionIds: number[];
}

export interface ReconcileOptions {
  /// Id source for adopted tabs — injectable so tests are deterministic.
  generateId?: () => string;
  /// Reserved pane ids (>= 0x8000_0000) that currently hold a plugin panel
  /// (plugin spec §4). The daemon knows nothing about them — they are panels,
  /// not sessions — so without this set the dead sweep would report every one
  /// of them and the panes would render as corpses on every boot.
  ///
  /// Membership is the BINDING, not the range: a reserved id whose binding was
  /// lost is deliberately left in `deadSessionIds`, which is what makes it the
  /// dismissible dead pane the spec requires (and exactly what an older build
  /// without this option sees). Ids outside the reserved range are ignored —
  /// they cannot be panels, and sparing one would strand a real dead session.
  ///
  /// Orphan adoption needs no equivalent guard: orphans come from the host's
  /// own session list, which can never contain a reserved id.
  pluginPaneIds?: ReadonlySet<number>;
}

function defaultGenerateId(): string {
  return crypto.randomUUID();
}

function adoptionTab(id: string, sessionId: number): Tab {
  return {
    id,
    title: null,
    color: "slate",
    fill: "off",
    split: { kind: "pane", sessionId },
  };
}

function freshTabId(
  generateId: () => string,
  taken: ReadonlySet<string>,
): string {
  let id = generateId();
  while (taken.has(id) || id.length === 0) {
    id = `${id || "tab"}-${taken.size}-x`;
  }
  return id;
}

/// `layout` is the parseLayout result: null means malformed or absent, which
/// triggers rule 3 (fresh flat layout from live sessions, never a crash and
/// never a silent migration). A valid layout with nothing to adopt is
/// returned unchanged by identity.
export function reconcile(
  layout: Layout | null,
  hostSessions: readonly SessionLike[],
  opts?: ReconcileOptions,
): ReconcileResult {
  const generateId = opts?.generateId ?? defaultGenerateId;

  if (layout === null) {
    const taken = new Set<string>();
    const tabs: Record<string, Tab> = {};
    const rootItems: Item[] = [];
    const orphanAdoptedIds: number[] = [];
    for (const session of hostSessions) {
      if (!session.alive) {
        continue;
      }
      const id = freshTabId(generateId, taken);
      taken.add(id);
      tabs[id] = adoptionTab(id, session.id);
      rootItems.push({ kind: "tab", id });
      orphanAdoptedIds.push(session.id);
    }
    return {
      layout: {
        version: 3,
        groups: {},
        rootItems,
        tabs,
        activeTabId: rootItems[0]?.id ?? null,
        auxWindows: {},
      },
      deadSessionIds: [],
      orphanAdoptedIds,
      unreferencedDeadSessionIds: hostSessions
        .filter((s) => !s.alive)
        .map((s) => s.id),
    };
  }

  const referenced = new Set(sessionIdsInLayout(layout));
  const alive = new Set(
    hostSessions.filter((s) => s.alive).map((s) => s.id),
  );

  const pluginPaneIds = opts?.pluginPaneIds;
  // The RANGE is checked as well as the membership. A caller that put a real
  // daemon id in the set would otherwise take a genuinely dead session out of
  // `deadSessionIds`, and since Dismiss works off that list its pane would
  // render as a corpse nobody can clear. A plugin pane is by definition a
  // reserved id, so the two conditions cost nothing together.
  const isLivePluginPane = (id: number): boolean =>
    pluginPaneIds?.has(id) === true && isPluginPaneId(id);
  const deadSessionIds = [...referenced].filter(
    (id) => !alive.has(id) && !isLivePluginPane(id),
  );
  const orphans = hostSessions.filter((s) => s.alive && !referenced.has(s.id));
  const unreferencedDeadSessionIds = hostSessions
    .filter((s) => !s.alive && !referenced.has(s.id))
    .map((s) => s.id);

  if (orphans.length === 0) {
    return {
      layout,
      deadSessionIds,
      orphanAdoptedIds: [],
      unreferencedDeadSessionIds,
    };
  }

  const taken = new Set(Object.keys(layout.tabs));
  const tabs = { ...layout.tabs };
  const rootItems = [...layout.rootItems];
  const orphanAdoptedIds: number[] = [];
  for (const session of orphans) {
    const id = freshTabId(generateId, taken);
    taken.add(id);
    tabs[id] = adoptionTab(id, session.id);
    rootItems.push({ kind: "tab", id });
    orphanAdoptedIds.push(session.id);
  }

  return {
    layout: { ...layout, tabs, rootItems },
    deadSessionIds,
    orphanAdoptedIds,
    unreferencedDeadSessionIds,
  };
}
