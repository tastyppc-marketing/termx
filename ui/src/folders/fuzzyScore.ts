/**
 * Folder-search matching: recents are fuzzy-scored, live completions keep the
 * backend's order. Pure module.
 */

export interface FolderRow {
  path: string;
  kind: "recent" | "dir";
}

/**
 * Score a folder against a query. Higher is better; null = no match. Every
 * whitespace-separated token must match somewhere; matches in the leaf
 * folder name beat matches elsewhere in the path.
 */
export function scoreFolder(query: string, path: string): number | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return 0;
  }
  const lowered = path.toLowerCase();
  const leafStart =
    Math.max(lowered.lastIndexOf("\\"), lowered.lastIndexOf("/")) + 1;
  const leaf = lowered.slice(leafStart);
  let total = 0;
  for (const token of trimmed.split(/\s+/)) {
    const leafIndex = leaf.indexOf(token);
    if (leafIndex === 0) {
      total += 300;
    } else if (leafIndex > 0) {
      total += 200;
    } else if (lowered.includes(token)) {
      total += 100;
    } else {
      return null;
    }
  }
  return total;
}

/**
 * Only path-like queries consult live directory completion — for plain words
 * the backend would return drive roots, which is noise next to recents.
 */
export function isPathLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  return (
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/")
  );
}

/**
 * Merge scored recents (best first; MRU order breaks ties via stable sort)
 * with backend completions (order preserved), deduplicated case-insensitively,
 * capped.
 */
export function mergeFolderResults(
  query: string,
  recents: readonly string[],
  completions: readonly string[],
  cap = 12,
): FolderRow[] {
  const rows: FolderRow[] = [];
  const seen = new Set<string>();
  const scored = recents
    .map((path) => ({ path, score: scoreFolder(query, path) }))
    .filter((entry): entry is { path: string; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score);
  for (const { path } of scored) {
    const normalized = path.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      rows.push({ path, kind: "recent" });
    }
  }
  for (const path of completions) {
    const normalized = path.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      rows.push({ path, kind: "dir" });
    }
  }
  return rows.slice(0, cap);
}

/** Split a path into parent + leaf for display (leaf emphasized). */
export function splitForDisplay(path: string): { parent: string; leaf: string } {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut <= 0 || cut === path.length - 1) {
    return { parent: "", leaf: path };
  }
  return { parent: path.slice(0, cut + 1), leaf: path.slice(cut + 1) };
}
