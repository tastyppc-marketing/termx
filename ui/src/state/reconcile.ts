import { sessionIdsInLayout } from "./layout";
import type { LayoutV1, Tab } from "./layout";

/// Boot-time reconciliation of the persisted layout against the host's actual
/// session list (spec "Restore reconciliation", rules 1–3).
///
/// Dead placeholders are represented OUT of band: panes referencing dead
/// sessions stay in the tree (they must render "session ended — Dismiss"
/// until the user dismisses them) and their session ids are reported in
/// `deadSessionIds`. No flag is added to the layout itself — the serialized
/// blob may only contain fields from the layout_v1 spec.
///
/// Structurally compatible with protocol SessionInfo.
export interface SessionLike {
  id: number;
  alive: boolean;
}

export interface ReconcileResult {
  layout: LayoutV1;
  /// Session ids referenced by panes but not alive (absent host-side, or
  /// present with alive=false). Their panes render dead placeholders;
  /// Dismiss prunes the pane and CloseSessions ids still known to the host.
  deadSessionIds: number[];
  /// Live session ids that no tab referenced — each was adopted into a new
  /// one-pane ungrouped slate tab at tail position (rule 2). With a
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
}

function defaultGenerateId(): string {
  return crypto.randomUUID();
}

function adoptionTab(id: string, sessionId: number): Tab {
  return {
    id,
    title: null,
    color: "slate",
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
  layout: LayoutV1 | null,
  hostSessions: readonly SessionLike[],
  opts?: ReconcileOptions,
): ReconcileResult {
  const generateId = opts?.generateId ?? defaultGenerateId;

  if (layout === null) {
    const taken = new Set<string>();
    const tabs: Record<string, Tab> = {};
    const ungroupedTabIds: string[] = [];
    const orphanAdoptedIds: number[] = [];
    for (const session of hostSessions) {
      if (!session.alive) {
        continue;
      }
      const id = freshTabId(generateId, taken);
      taken.add(id);
      tabs[id] = adoptionTab(id, session.id);
      ungroupedTabIds.push(id);
      orphanAdoptedIds.push(session.id);
    }
    return {
      layout: {
        version: 1,
        groups: [],
        ungroupedTabIds,
        tabs,
        activeTabId: ungroupedTabIds[0] ?? null,
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

  const deadSessionIds = [...referenced].filter((id) => !alive.has(id));
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
  const ungroupedTabIds = [...layout.ungroupedTabIds];
  const orphanAdoptedIds: number[] = [];
  for (const session of orphans) {
    const id = freshTabId(generateId, taken);
    taken.add(id);
    tabs[id] = adoptionTab(id, session.id);
    ungroupedTabIds.push(id);
    orphanAdoptedIds.push(session.id);
  }

  return {
    layout: { ...layout, tabs, ungroupedTabIds },
    deadSessionIds,
    orphanAdoptedIds,
    unreferencedDeadSessionIds,
  };
}
