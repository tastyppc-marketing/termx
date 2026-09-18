/**
 * Scope directory tracking (spec F1).
 *
 * A *scope* is a sidebar group, or the ungrouped list (key ""). Each scope
 * carries a `seed` (spawn cwd of the first terminal created in it — set once)
 * and an `active` path (last observed CD in any of its live terminals — most
 * recent wins). Plain new tabs resolve their cwd from these, per the
 * settings policy. Pure data module; persistence lives in uiState.
 */

import type { NewTabPolicy } from "../settings/settings";

/** Group id, or "" for the ungrouped list. */
export type ScopeKey = string;

export const UNGROUPED_SCOPE: ScopeKey = "";

export function scopeKeyFor(groupId: string | null): ScopeKey {
  return groupId ?? UNGROUPED_SCOPE;
}

export interface ScopePathsState {
  readonly seeds: Readonly<Record<ScopeKey, string>>;
  readonly active: Readonly<Record<ScopeKey, string>>;
}

export const EMPTY_SCOPE_PATHS: ScopePathsState = { seeds: {}, active: {} };

/** Set the scope seed once; later seeds never move it. Same-ref when no-op. */
export function seedScope(
  state: ScopePathsState,
  key: ScopeKey,
  path: string | null,
): ScopePathsState {
  if (!path || state.seeds[key] !== undefined) {
    return state;
  }
  return { ...state, seeds: { ...state.seeds, [key]: path } };
}

/**
 * A live CD report: moves the scope's active path (most recent wins) and
 * seeds a seedless scope — a real CD is at least as good a seed as a spawn
 * dir we never saw. Same-ref when nothing changes.
 */
export function reportScopeCwd(
  state: ScopePathsState,
  key: ScopeKey,
  path: string,
): ScopePathsState {
  if (path.length === 0) {
    return state;
  }
  const seeded = seedScope(state, key, path);
  if (seeded.active[key] === path) {
    return seeded;
  }
  return { ...seeded, active: { ...seeded.active, [key]: path } };
}

/** Forget a deleted group's paths. Same-ref when the scope is unknown. */
export function dropScope(state: ScopePathsState, key: ScopeKey): ScopePathsState {
  if (state.seeds[key] === undefined && state.active[key] === undefined) {
    return state;
  }
  const seeds = { ...state.seeds };
  const active = { ...state.active };
  delete seeds[key];
  delete active[key];
  return { seeds, active };
}

/**
 * Ordered cwd candidates for a plain new tab under a non-ask policy. The
 * chain always ends with null (host default dir) so creation can never fail
 * on a stale path alone; callers try candidates in order.
 *
 * The workspace root (Settings > General) sits just before that final null
 * under every policy: it is where a terminal opens when nothing about the
 * tab or group has decided otherwise, never a stronger claim than a folder
 * the user has already been working in.
 */
export function newTabCwdCandidates(
  state: ScopePathsState,
  key: ScopeKey,
  policy: Exclude<NewTabPolicy, "ask-searcher" | "ask-native">,
  activeTabCwd: string | null,
  workspaceRoot: string | null,
): ReadonlyArray<string | null> {
  const chain: Array<string | null> = [];
  if (policy === "active-tab") {
    chain.push(activeTabCwd);
  }
  if (policy === "active-tab" || policy === "group-active") {
    chain.push(state.active[key] ?? null);
  }
  chain.push(state.seeds[key] ?? null, workspaceRoot, null);
  const seen = new Set<string>();
  return chain.filter((candidate) => {
    if (candidate === null) {
      return false;
    }
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  }).concat([null]);
}
