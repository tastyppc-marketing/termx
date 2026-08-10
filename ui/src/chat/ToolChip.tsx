/**
 * One tool call as a single chip line (chat-view spec §4): a status dot, what
 * the tool did, a short right-hand detail, and — when opened — the body.
 *
 * The chip is a button because that is what it is: the whole line toggles.
 */

import type { ToolEntry } from "./types";

export interface ToolChipProps {
  entry: ToolEntry;
  expanded: boolean;
  onToggle(): void;
}

const STATUS_LABEL: Record<ToolEntry["status"], string> = {
  running: "running",
  ok: "finished",
  error: "failed",
};

export function ToolChip({ entry, expanded, onToggle }: ToolChipProps) {
  const hasDetail = entry.detail.length > 0;
  return (
    <div className="chat-tool" data-testid="chat-tool" data-status={entry.status}>
      <button
        type="button"
        className="chat-tool__line"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className="chat-tool__dot"
          data-status={entry.status}
          aria-label={STATUS_LABEL[entry.status]}
          role="img"
        />
        <span className="chat-tool__title">{entry.title}</span>
        {entry.summary.length > 0 ? (
          <span className="chat-tool__summary">{entry.summary}</span>
        ) : null}
      </button>
      {expanded && hasDetail ? (
        <pre className="chat-tool__detail" data-testid="chat-tool-detail">
          {entry.detail}
        </pre>
      ) : null}
    </div>
  );
}
