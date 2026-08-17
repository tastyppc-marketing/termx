/**
 * Read-only `~/.ssh/config` parser (ssh-sessions spec §1).
 *
 * Line-based on purpose: this file is hand-maintained by the user, so the parse
 * has to survive shapes a strict grammar would reject — tabs, trailing
 * comments, `Key=value`, keywords TermX has no use for — and never throw. What
 * it cannot understand it drops: an unparseable file yields an empty inventory,
 * the Hosts surfaces show their hint, and nothing else in TermX notices.
 *
 * Wildcard blocks (`Host *`, `Host *.dev`) and `Match` blocks are skipped: they
 * configure other hosts rather than being connectable targets, and their
 * settings must not leak into the block that happens to precede them.
 */

import type { SshHost } from "./types";

/** Keyword plus value, separated by whitespace or the `=` spelling ssh allows. */
const KEYWORD_LINE = /^(\S+?)[\s=]+(.*)$/;

/** `Host web?` / `Host *.dev` are patterns, not hosts. */
const WILDCARD = /[*?]/;

type HostDraft = {
  -readonly [K in keyof SshHost]: K extends "aliases" ? string[] : SshHost[K];
};

/**
 * Trailing comments start at ` #`, never at a bare `#`: an IdentityFile of
 * `~/.ssh/key#1` is a real path, and ssh itself only ends a value at
 * whitespace-then-hash.
 */
function stripComment(value: string): string {
  const at = value.search(/\s#/);
  return (at >= 0 ? value.slice(0, at) : value).trim();
}

/** Parse the config text (null = missing file). Never throws. */
export function parseSshConfig(text: string | null): SshHost[] {
  if (text === null) {
    return [];
  }
  const drafts: HostDraft[] = [];
  const seen = new Set<string>();
  // null between blocks and inside a skipped one, so stray settings — before
  // the first Host, or under `Match` / `Host *` — land nowhere.
  let current: HostDraft | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = KEYWORD_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const keyword = match[1]!.toLowerCase();
    const value = stripComment(match[2]!);

    if (keyword === "match") {
      current = null;
      continue;
    }
    if (keyword === "host") {
      const aliases = value
        .split(/\s+/)
        .filter((token) => token.length > 0 && !WILDCARD.test(token));
      const alias = aliases[0];
      // A pattern-only line, or an alias already claimed by an earlier block:
      // ssh applies the first match, so the first block is the real one.
      if (alias === undefined || seen.has(alias)) {
        current = null;
        continue;
      }
      seen.add(alias);
      current = {
        alias,
        aliases,
        hostName: null,
        user: null,
        identityFile: null,
      };
      drafts.push(current);
      continue;
    }
    if (current === null || value.length === 0) {
      continue;
    }
    // First value wins, matching ssh's own precedence.
    if (keyword === "hostname" && current.hostName === null) {
      current.hostName = value;
    } else if (keyword === "user" && current.user === null) {
      current.user = value;
    } else if (keyword === "identityfile" && current.identityFile === null) {
      current.identityFile = value;
    }
  }
  return drafts;
}
