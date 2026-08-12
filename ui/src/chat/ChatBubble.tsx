/**
 * One conversation row (chat-view spec §4).
 *
 * Prompts sit right and accent-tinted, the agent sits left on `--surface-1`,
 * thinking collapses to a line, and tools are chips. Assistant markdown goes
 * through `react-markdown` with `rehype-sanitize`'s default schema — raw HTML
 * is stripped and nothing is ever fetched — and a bubble whose markdown fails
 * to render falls back to its own plain text rather than taking the view down
 * with it.
 */

import { Component, type ReactNode } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { ToolChip } from "./ToolChip";
import type { ChatEntry } from "./types";

/** Per-entry containment: one bad row must not blank the conversation. */
export class EntryErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function AssistantBubble({ markdown }: { markdown: string }) {
  return (
    <div className="chat-bubble chat-bubble--assistant" data-testid="chat-assistant">
      <EntryErrorBoundary
        fallback={<pre className="chat-bubble__plain">{markdown}</pre>}
      >
        <div className="chat-markdown">
          <Markdown rehypePlugins={[rehypeSanitize]}>{markdown}</Markdown>
        </div>
      </EntryErrorBoundary>
    </div>
  );
}

/**
 * Owned by the view, like a tool chip: the default comes from the header's
 * "Thoughts" preference and a click is a per-row override. The open body is a
 * capped scroll box (CSS), so a long thought never swallows the conversation.
 */
function ThinkingRow({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <div className="chat-thinking" data-testid="chat-thinking">
      <button
        type="button"
        className="chat-thinking__toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "Thinking — hide" : "Thinking — show"}
      </button>
      {expanded ? <pre className="chat-thinking__body">{text}</pre> : null}
    </div>
  );
}

export interface ChatBubbleProps {
  entry: ChatEntry;
  /** Whether a tool or thinking entry's body is open; ignored otherwise. */
  expanded: boolean;
  onToggle(id: string): void;
}

export function ChatBubble({ entry, expanded, onToggle }: ChatBubbleProps) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="chat-bubble chat-bubble--user" data-testid="chat-user">
          <pre className="chat-bubble__plain">{entry.text}</pre>
        </div>
      );
    case "assistant":
      return <AssistantBubble markdown={entry.markdown} />;
    case "thinking":
      return (
        <ThinkingRow
          text={entry.text}
          expanded={expanded}
          onToggle={() => onToggle(entry.id)}
        />
      );
    case "tool":
      return (
        <ToolChip
          entry={entry}
          expanded={expanded}
          onToggle={() => onToggle(entry.id)}
        />
      );
    case "system":
      return (
        <div className="chat-system" data-testid="chat-system" role="note">
          {entry.text}
        </div>
      );
  }
}
