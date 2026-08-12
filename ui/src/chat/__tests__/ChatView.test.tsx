import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntryErrorBoundary } from "../ChatBubble";
import { ChatView, CTRL_C_KEY, ESC_KEY, RENDER_WINDOW } from "../ChatView";
import type { ChatFeed } from "../feed";
import type { ChatEntry } from "../types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

/** A feed the test drives by hand; no timers, no host. */
function fakeFeed(initial: ChatEntry[] = []): ChatFeed & {
  push(entries: ChatEntry[]): void;
  setStale(stale: boolean): void;
} {
  const entries = [...initial];
  const updates = new Set<() => void>();
  const stales = new Set<(stale: boolean) => void>();
  let stale = false;
  return {
    get entries() {
      return entries;
    },
    get stale() {
      return stale;
    },
    onUpdate(listener) {
      updates.add(listener);
      return () => updates.delete(listener);
    },
    onStale(listener) {
      stales.add(listener);
      return () => stales.delete(listener);
    },
    dispose() {},
    push(next) {
      entries.push(...next);
      for (const listener of [...updates]) listener();
    },
    setStale(next) {
      stale = next;
      for (const listener of [...stales]) listener(next);
    },
  };
}

function header(overrides: Partial<Parameters<typeof ChatView>[0]["header"]> = {}) {
  return { title: "Session", onFlipToTerminal: () => undefined, ...overrides };
}

/** Every prop filled with an inert default; a test states only what it tests. */
function view(
  props: Partial<React.ComponentProps<typeof ChatView>> & { feed: ChatFeed },
): React.ReactElement {
  return (
    <ChatView
      density="chips"
      onDensityChange={() => undefined}
      showThinking={false}
      onShowThinkingChange={() => undefined}
      sendKeys={() => undefined}
      header={header()}
      {...props}
    />
  );
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) {
    throw new Error(`button "${text}" not found`);
  }
  return found;
}

const entries: ChatEntry[] = [
  { kind: "user", id: "u1", ts: 1, text: "run the tests" },
  { kind: "assistant", id: "a1", ts: 2, markdown: "Running **now**" },
  { kind: "thinking", id: "t1", ts: 3, text: "weighing the options" },
  {
    kind: "tool",
    id: "call_1",
    ts: 4,
    name: "Bash",
    title: "cargo test",
    summary: "Run the suite",
    status: "ok",
    detail: "162 passed",
  },
  { kind: "system", id: "s1", ts: 5, text: "Conversation compacted" },
];

describe("ChatView", () => {
  it("renders one row per entry kind", async () => {
    await render(view({ feed: fakeFeed(entries) }));

    expect(container.querySelector('[data-testid="chat-user"]')?.textContent).toBe(
      "run the tests",
    );
    const assistant = container.querySelector('[data-testid="chat-assistant"]');
    expect(assistant?.querySelector("strong")?.textContent).toBe("now");
    expect(container.querySelector('[data-testid="chat-thinking"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-tool"]')?.textContent).toContain(
      "cargo test",
    );
    expect(container.querySelector('[data-testid="chat-system"]')?.textContent).toBe(
      "Conversation compacted",
    );
  });

  it("renders assistant markdown without letting raw HTML through", async () => {
    await render(
      view({
        feed: fakeFeed([
          {
            kind: "assistant",
            id: "a2",
            ts: 1,
            markdown:
              '# Heading\n\n<img src="x" onerror="window.__pwned = true">\n\n<script>window.__pwned = true</script>\n\n`code`',
          },
        ]),
      }),
    );
    const bubble = container.querySelector('[data-testid="chat-assistant"]');
    expect(bubble?.querySelector("h1")?.textContent).toBe("Heading");
    expect(bubble?.querySelector("code")?.textContent).toBe("code");
    expect(bubble?.querySelector("img")).toBeNull();
    expect(bubble?.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("keeps a tool body closed on chips and open on full", async () => {
    const feed = fakeFeed(entries);
    await render(view({ feed, density: "chips" }));
    expect(container.querySelector('[data-testid="chat-tool-detail"]')).toBeNull();

    await render(view({ feed, density: "full" }));
    expect(
      container.querySelector('[data-testid="chat-tool-detail"]')?.textContent,
    ).toBe("162 passed");
  });

  it("lets a click open one chip against the density", async () => {
    await render(view({ feed: fakeFeed(entries), density: "chips" }));
    const chip = container.querySelector<HTMLButtonElement>(".chat-tool__line");
    await act(async () => chip?.click());
    expect(
      container.querySelector('[data-testid="chat-tool-detail"]')?.textContent,
    ).toBe("162 passed");
    expect(chip?.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the reasoning by default when the preference says so, in a scroll box", async () => {
    const feed = fakeFeed(entries);
    await render(view({ feed, showThinking: true, density: "chips" }));
    // The thoughts are open even though every tool stays a chip.
    expect(container.querySelector(".chat-thinking__body")?.textContent).toBe(
      "weighing the options",
    );
    expect(container.querySelector('[data-testid="chat-tool-detail"]')).toBeNull();

    await render(view({ feed, showThinking: false, density: "chips" }));
    expect(container.querySelector(".chat-thinking__body")).toBeNull();
  });

  it("lets a click close one thought against the preference", async () => {
    await render(view({ feed: fakeFeed(entries), showThinking: true }));
    const toggle = container.querySelector<HTMLButtonElement>(".chat-thinking__toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle?.click());
    expect(container.querySelector(".chat-thinking__body")).toBeNull();
    await act(async () => toggle?.click());
    expect(container.querySelector(".chat-thinking__body")).not.toBeNull();
  });

  it("reports the Thoughts preference and clears per-row overrides with it", async () => {
    const picked: boolean[] = [];
    const feed = fakeFeed(entries);
    await render(
      view({ feed, showThinking: true, onShowThinkingChange: (next) => picked.push(next) }),
    );

    // Close this one row by hand, then flip the preference off and back on:
    // the override must not survive, or the row would stay stuck closed.
    const toggle = container.querySelector<HTMLButtonElement>(".chat-thinking__toggle");
    await act(async () => toggle?.click());
    expect(container.querySelector(".chat-thinking__body")).toBeNull();

    await act(async () => button("Thoughts").click());
    expect(picked).toEqual([false]);

    await render(view({ feed, showThinking: true }));
    expect(container.querySelector(".chat-thinking__body")).not.toBeNull();
  });

  it("reports the density the user picked", async () => {
    const picked: string[] = [];
    await render(
      view({
        feed: fakeFeed(entries),
        density: "smart",
        onDensityChange: (density) => picked.push(density),
      }),
    );
    await act(async () => button("full").click());
    expect(picked).toEqual(["full"]);
    expect(button("smart").getAttribute("aria-pressed")).toBe("true");
  });

  it("sends Escape and Ctrl+C to the session, and nothing else on its own", async () => {
    const sent: string[] = [];
    await render(
      view({ feed: fakeFeed(entries), density: "smart", sendKeys: (data) => sent.push(data) }),
    );
    expect(sent).toEqual([]);
    await act(async () => button("Esc").click());
    await act(async () => button("Ctrl+C").click());
    expect(sent).toEqual([ESC_KEY, CTRL_C_KEY]);
  });

  it("shows new entries as the feed reports them", async () => {
    const feed = fakeFeed(entries);
    await render(view({ feed }));
    await act(async () =>
      feed.push([{ kind: "user", id: "u2", ts: 6, text: "and again" }]),
    );
    expect(container.textContent).toContain("and again");
  });

  it("raises a stale banner and takes it down again", async () => {
    const feed = fakeFeed(entries);
    await render(view({ feed }));
    expect(container.querySelector('[data-testid="chat-stale"]')).toBeNull();
    await act(async () => feed.setStale(true));
    expect(container.querySelector('[data-testid="chat-stale"]')).not.toBeNull();
    await act(async () => feed.setStale(false));
    expect(container.querySelector('[data-testid="chat-stale"]')).toBeNull();
  });

  it("holds a render window and offers the rest behind a button", async () => {
    const many: ChatEntry[] = Array.from({ length: RENDER_WINDOW + 3 }, (_, index) => ({
      kind: "user" as const,
      id: `u${index}`,
      ts: index,
      text: `message ${index}`,
    }));
    await render(view({ feed: fakeFeed(many) }));
    expect(container.querySelectorAll('[data-testid="chat-user"]')).toHaveLength(
      RENDER_WINDOW,
    );
    await act(async () => button("Show earlier").click());
    expect(container.querySelectorAll('[data-testid="chat-user"]')).toHaveLength(
      RENDER_WINDOW + 3,
    );
  });

  it("offers a jump-to-latest pill once the reader scrolls up", async () => {
    await render(view({ feed: fakeFeed(entries) }));
    expect(container.querySelector('[data-testid="chat-jump"]')).toBeNull();

    // jsdom has no layout: the scroll geometry has to be stated.
    const scroll = container.querySelector<HTMLDivElement>(
      '[data-testid="chat-scroll"]',
    );
    if (!scroll) {
      throw new Error("no scroll region");
    }
    Object.defineProperty(scroll, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 200, configurable: true });
    scroll.scrollTop = 100;
    await act(async () => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(container.querySelector('[data-testid="chat-jump"]')).not.toBeNull();

    await act(async () => button("Jump to latest").click());
    expect(scroll.scrollTop).toBe(1000);
    expect(container.querySelector('[data-testid="chat-jump"]')).toBeNull();
  });

  it("hides the link picker until one is offered", async () => {
    const feed = fakeFeed(entries);
    await render(view({ feed }));
    expect(() => button("Link conversation…")).toThrow();

    let opened = 0;
    await render(
      view({ feed, header: header({ onOpenLinkPicker: () => (opened += 1) }) }),
    );
    await act(async () => button("Link conversation…").click());
    expect(opened).toBe(1);
  });
});

describe("EntryErrorBoundary", () => {
  it("falls back to plain text when a bubble cannot render", async () => {
    const noise = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Explode(): React.ReactElement {
      throw new Error("markdown blew up");
    }
    await render(
      <EntryErrorBoundary fallback={<pre>the raw text</pre>}>
        <Explode />
      </EntryErrorBoundary>,
    );
    expect(container.textContent).toBe("the raw text");
    noise.mockRestore();
  });
});
