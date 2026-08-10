import { describe, expect, it } from "vitest";
import { CHAT_POLL_MS, openChatFeed, type InvokeFn } from "../feed";
import type { ChatEntry, FeedWindow } from "../types";

/** A manual clock: nothing fires until the test says so. */
function testScheduler() {
  const pending = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  let now = 0;
  return {
    schedule: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      pending.set(id, { at: now + delayMs, run: callback });
      return () => {
        pending.delete(id);
      };
    },
    get pendingCount() {
      return pending.size;
    },
    /** Run every timer due at or before `now + delayMs`, once. */
    advance(delayMs: number) {
      now += delayMs;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
  };
}

function user(id: string, text: string): ChatEntry {
  return { kind: "user", id, ts: 1, text };
}

function tool(id: string, status: "running" | "ok" | "error"): ChatEntry {
  return {
    kind: "tool",
    id,
    ts: 1,
    name: "Bash",
    title: "cargo test",
    summary: "",
    status,
    detail: status === "running" ? "" : "162 passed",
  };
}

function window(entries: ChatEntry[], overrides: Partial<FeedWindow> = {}): FeedWindow {
  return { feedId: 7, entries, offset: 100, reset: false, ...overrides };
}

/**
 * A fake command surface: `open` answers once, then each queued `poll` answer
 * is consumed in order (a rejection is thrown).
 */
function fakeInvoke(opened: FeedWindow, polls: (FeedWindow | Error)[]) {
  const calls: { command: string; args: unknown }[] = [];
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    if (command === "chat_feed_open") {
      return opened as never;
    }
    if (command === "chat_feed_poll") {
      const next = polls.shift();
      if (next === undefined) {
        return window([]) as never;
      }
      if (next instanceof Error) {
        throw next;
      }
      return next as never;
    }
    return undefined as never;
  };
  return { invoke, calls };
}

/** Let the microtask queue drain so an awaited invoke has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openChatFeed", () => {
  it("starts from the opening window and appends what each poll brings", async () => {
    const clock = testScheduler();
    const { invoke, calls } = fakeInvoke(
      window([user("a", "first")], { reset: true }),
      [window([user("b", "second")])],
    );

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    expect(calls[0]).toEqual({
      command: "chat_feed_open",
      args: { path: "T.jsonl" },
    });
    expect(feed.entries.map((entry) => entry.id)).toEqual(["a"]);

    let updates = 0;
    feed.onUpdate(() => {
      updates += 1;
    });

    clock.advance(CHAT_POLL_MS);
    await settle();

    expect(calls[1]).toEqual({
      command: "chat_feed_poll",
      args: { feedId: 7 },
    });
    expect(feed.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(updates).toBe(1);
    feed.dispose();
  });

  it("replaces a running tool with its finished self, in place", async () => {
    const clock = testScheduler();
    const { invoke } = fakeInvoke(
      window([user("a", "go"), tool("call_1", "running")], { reset: true }),
      [window([tool("call_1", "ok")]), window([user("z", "next")])],
    );

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    clock.advance(CHAT_POLL_MS);
    await settle();

    expect(feed.entries.map((entry) => entry.id)).toEqual(["a", "call_1"]);
    expect(feed.entries[1]).toMatchObject({ status: "ok", detail: "162 passed" });

    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(feed.entries.map((entry) => entry.id)).toEqual(["a", "call_1", "z"]);
    feed.dispose();
  });

  it("throws everything away when a window says the file was rewritten", async () => {
    const clock = testScheduler();
    const { invoke } = fakeInvoke(window([user("a", "old")], { reset: true }), [
      window([user("b", "after compaction")], { reset: true }),
    ]);

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    clock.advance(CHAT_POLL_MS);
    await settle();

    expect(feed.entries.map((entry) => entry.id)).toEqual(["b"]);
    feed.dispose();
  });

  it("reports stale on a failed poll and clears it on the next good one", async () => {
    const clock = testScheduler();
    const { invoke } = fakeInvoke(window([user("a", "first")], { reset: true }), [
      new Error("file locked"),
      window([user("b", "back")]),
    ]);

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    const seen: boolean[] = [];
    feed.onStale((stale) => seen.push(stale));

    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(feed.stale).toBe(true);
    expect(seen).toEqual([true]);

    // A failure must not stop the polling — the retry IS the next tick.
    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(feed.stale).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(feed.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    feed.dispose();
  });

  it("stops polling on dispose and closes the feed", async () => {
    const clock = testScheduler();
    const { invoke, calls } = fakeInvoke(window([user("a", "first")], { reset: true }), [
      window([user("b", "second")]),
    ]);

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    feed.dispose();
    await settle();

    expect(calls.map((call) => call.command)).toEqual([
      "chat_feed_open",
      "chat_feed_close",
    ]);
    expect(calls[1]?.args).toEqual({ feedId: 7 });
    expect(clock.pendingCount).toBe(0);

    clock.advance(CHAT_POLL_MS * 4);
    await settle();
    expect(calls.map((call) => call.command)).toEqual([
      "chat_feed_open",
      "chat_feed_close",
    ]);
    expect(feed.entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("ignores a poll that lands after dispose", async () => {
    const clock = testScheduler();
    let release: (value: FeedWindow) => void = () => undefined;
    const invoke: InvokeFn = async (command) => {
      if (command === "chat_feed_open") {
        return window([user("a", "first")], { reset: true }) as never;
      }
      if (command === "chat_feed_poll") {
        return new Promise<FeedWindow>((resolve) => {
          release = resolve;
        }) as never;
      }
      return undefined as never;
    };

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    clock.advance(CHAT_POLL_MS);
    feed.dispose();
    release(window([user("b", "too late")]));
    await settle();

    expect(feed.entries.map((entry) => entry.id)).toEqual(["a"]);
    expect(clock.pendingCount).toBe(0);
  });

  it("subscribers can unsubscribe", async () => {
    const clock = testScheduler();
    const { invoke } = fakeInvoke(window([user("a", "first")], { reset: true }), [
      window([user("b", "second")]),
      window([user("c", "third")]),
    ]);

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    let updates = 0;
    const stop = feed.onUpdate(() => {
      updates += 1;
    });

    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(updates).toBe(1);

    stop();
    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(updates).toBe(1);
    expect(feed.entries).toHaveLength(3);
    feed.dispose();
  });

  it("an empty poll changes nothing and notifies nobody", async () => {
    const clock = testScheduler();
    const { invoke } = fakeInvoke(window([user("a", "first")], { reset: true }), [
      window([]),
    ]);

    const feed = await openChatFeed("T.jsonl", invoke, clock.schedule);
    let updates = 0;
    feed.onUpdate(() => {
      updates += 1;
    });

    clock.advance(CHAT_POLL_MS);
    await settle();
    expect(updates).toBe(0);
    expect(feed.entries).toHaveLength(1);
    feed.dispose();
  });

  it("a failed open rejects and opens no feed", async () => {
    const clock = testScheduler();
    const invoke: InvokeFn = async () => {
      throw new Error("no such transcript");
    };
    await expect(openChatFeed("T.jsonl", invoke, clock.schedule)).rejects.toThrow(
      "no such transcript",
    );
    expect(clock.pendingCount).toBe(0);
  });
});
