/**
 * A small markdown renderer for the file viewer (spec §12) — headings,
 * paragraphs, emphasis, fenced code, lists, links, GFM pipe tables and
 * blockquotes. Deliberately NOT a library: the viewer opens whatever an AI
 * run wrote to disk, so the renderer is the trust boundary and it earns that
 * by only ever producing React elements.
 *
 * Consequences of that rule, all load-bearing:
 * - No `dangerouslySetInnerHTML` anywhere, so raw HTML in a file renders as
 *   the literal characters the author typed — `<script>` is text, never a tag.
 * - Links render as titled text, never an `<a>`: a viewer pane inside a
 *   desktop shell must not be able to navigate the window away from the app.
 * - Unsupported constructs degrade to paragraph text rather than throwing;
 *   there is no parse error a file can cause.
 */

import { createElement, type ReactNode } from "react";

/**
 * One pass over a line of prose. Alternation order matters: links first (they
 * contain other markers), then strong before emphasis so `**x**` never reads
 * as two italics. Inline code wins wherever it starts because its content is
 * taken verbatim — no recursion, no nested formatting inside backticks.
 *
 * `_`-delimited emphasis requires non-word neighbours so `snake_case_name`
 * and `__init__` survive intact; `*` has no such rule, matching GFM.
 */
const INLINE_PATTERN =
  /(\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(?<![\w\\])__([^_]+)__(?!\w)|\*([^*]+)\*|(?<![\w\\])_([^_]+)_(?!\w)|`([^`]+)`)/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE_PATTERN.source, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const key = `inline-${match.index}`;
    if (match[2] !== undefined && match[3] !== undefined) {
      // Text + href in the tooltip: everything the reader needs, no navigation.
      nodes.push(
        createElement(
          "span",
          { className: "viewer-markdown__link", key, title: match[3] },
          renderInline(match[2]),
        ),
      );
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push(createElement("strong", { key }, match[4] ?? match[5]));
    } else if (match[6] !== undefined || match[7] !== undefined) {
      nodes.push(createElement("em", { key }, match[6] ?? match[7]));
    } else {
      nodes.push(
        createElement(
          "code",
          { className: "viewer-markdown__code", key },
          match[8],
        ),
      );
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

interface ListItemLine {
  indent: number;
  ordered: boolean;
  text: string;
}

function matchListItem(line: string): ListItemLine | null {
  const match = LIST_ITEM.exec(line);
  if (!match) {
    return null;
  }
  return {
    indent: (match[1] ?? "").length,
    ordered: match[2] === undefined,
    text: match[4] ?? "",
  };
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  // The pipe is required: without it a `---` rule under a line containing a
  // pipe would turn an ordinary paragraph into a one-column table.
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/** True when the line opens a new block, so a paragraph must stop before it. */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    matchListItem(line) !== null ||
    (line.includes("|") && isTableSeparator(lines[index + 1] ?? ""))
  );
}

/**
 * One list, including nested sub-lists. Two-space-deeper items become a child
 * list of the preceding item; a switch between bullets and numbers at the same
 * indent starts a sibling list instead of silently re-typing the current one.
 */
function parseList(
  lines: readonly string[],
  start: number,
  first: ListItemLine,
): { node: ReactNode; next: number } {
  const entries: { text: string; children: ReactNode[] }[] = [];
  let index = start;

  while (index < lines.length) {
    const item = matchListItem(lines[index] ?? "");
    if (!item) {
      break;
    }
    const lastEntry = entries[entries.length - 1];
    if (item.indent >= first.indent + 2 && lastEntry) {
      const nested = parseList(lines, index, item);
      lastEntry.children.push(nested.node);
      index = nested.next;
      continue;
    }
    // Anything shallower belongs to an enclosing list; a marker switch at the
    // same depth starts a sibling list rather than re-typing this one.
    if (
      Math.abs(item.indent - first.indent) > 1 ||
      item.ordered !== first.ordered
    ) {
      break;
    }
    entries.push({ text: item.text, children: [] });
    index += 1;
  }

  const node = createElement(
    first.ordered ? "ol" : "ul",
    { key: `block-${start}` },
    entries.map((entry, itemIndex) =>
      createElement(
        "li",
        { key: `item-${itemIndex}` },
        renderInline(entry.text),
        ...entry.children,
      ),
    ),
  );
  return { node, next: index };
}

/** Render markdown source as React elements. Never throws. */
export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      // The info string (```ts) is read and dropped: no highlighting in v1.
      const start = index;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        createElement(
          "pre",
          { className: "viewer-markdown__pre", key: `block-${start}` },
          createElement("code", null, code.join("\n")),
        ),
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push(
        createElement(
          `h${(heading[1] ?? "#").length}`,
          { key: `block-${index}` },
          renderInline(heading[2] ?? ""),
        ),
      );
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(createElement("hr", { key: `block-${index}` }));
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const start = index;
      const quoted: string[] = [];
      while (index < lines.length) {
        const part = QUOTE.exec(lines[index] ?? "");
        if (!part) {
          break;
        }
        quoted.push(part[1] ?? "");
        index += 1;
      }
      blocks.push(
        createElement(
          "blockquote",
          { key: `block-${start}` },
          renderInline(quoted.join(" ")),
        ),
      );
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const start = index;
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").trim().length > 0 &&
        (lines[index] ?? "").includes("|")
      ) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        createElement(
          "table",
          { className: "viewer-markdown__table", key: `block-${start}` },
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              headers.map((header, cellIndex) =>
                createElement(
                  "th",
                  { key: `header-${cellIndex}`, scope: "col" },
                  renderInline(header),
                ),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            rows.map((row, rowIndex) =>
              createElement(
                "tr",
                { key: `row-${rowIndex}` },
                // Header count wins: ragged rows pad instead of shifting.
                headers.map((_, cellIndex) =>
                  createElement(
                    "td",
                    { key: `cell-${cellIndex}` },
                    renderInline(row[cellIndex] ?? ""),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem) {
      const list = parseList(lines, index, listItem);
      blocks.push(list.node);
      index = list.next;
      continue;
    }

    const start = index;
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim().length === 0 || (index > start && startsBlock(lines, index))) {
        break;
      }
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push(
      createElement(
        "p",
        { key: `block-${start}` },
        renderInline(paragraph.join(" ")),
      ),
    );
  }

  return blocks;
}
