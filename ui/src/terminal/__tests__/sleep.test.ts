import { describe, expect, it, vi } from "vitest";
import type { SleepOption } from "../../settings/settings";
import {
  SLEEP_THRESHOLD_MS,
  SleepController,
  SleepTracker,
  sleepThresholdMs,
} from "../sleep";

const MINUTE = 60_000;

function trackerFixture(option: SleepOption) {
  let now = 1_000_000;
  const tracker = new SleepTracker({ option, now: () => now });
  return {
    tracker,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("sleepThresholdMs", () => {
  it("maps every setting value to its idle budget", () => {
    expect(sleepThresholdMs("off")).toBeNull();
    expect(sleepThresholdMs("5")).toBe(5 * MINUTE);
    expect(sleepThresholdMs("15")).toBe(15 * MINUTE);
    expect(sleepThresholdMs("60")).toBe(60 * MINUTE);
    expect(SLEEP_THRESHOLD_MS["60"]).toBe(60 * MINUTE);
  });
});

describe("SleepTracker", () => {
  it.each([
    ["5", 5 * MINUTE],
    ["15", 15 * MINUTE],
    ["60", 60 * MINUTE],
  ] as const)("sleeps a hidden pane exactly at the %s minute threshold", (option, threshold) => {
    const { tracker, advance } = trackerFixture(option);
    tracker.observe([7], false);

    advance(threshold - 1);
    expect(tracker.isSleeping(7)).toBe(false);
    expect([...tracker.sleepingSessions()]).toEqual([]);

    advance(1);
    expect(tracker.isSleeping(7)).toBe(true);
    expect([...tracker.sleepingSessions()]).toEqual([7]);
  });

  it("never sleeps a visible pane, however long it stays on screen", () => {
    const { tracker, advance } = trackerFixture("5");
    tracker.observe([1, 2], true);

    advance(24 * 60 * MINUTE);

    expect(tracker.isSleeping(1)).toBe(false);
    expect(tracker.isSleeping(2)).toBe(false);
    expect(tracker.msUntilNextSleep()).toBeNull();
  });

  it("never sleeps anything while the setting is off", () => {
    const { tracker, advance } = trackerFixture("off");
    tracker.observe([1], false);

    advance(24 * 60 * MINUTE);

    expect(tracker.isSleeping(1)).toBe(false);
    expect(tracker.msUntilNextSleep()).toBeNull();
  });

  it("wakes a sleeping pane the moment it becomes visible", () => {
    const { tracker, advance } = trackerFixture("15");
    tracker.observe([3], false);
    advance(15 * MINUTE);
    expect(tracker.isSleeping(3)).toBe(true);

    tracker.observe([3], true);

    expect(tracker.isSleeping(3)).toBe(false);
    advance(60 * MINUTE);
    expect(tracker.isSleeping(3)).toBe(false);
  });

  it("restarts the idle clock on an explicit wake without revealing the pane", () => {
    const { tracker, advance } = trackerFixture("5");
    tracker.observe([4], false);
    advance(5 * MINUTE);
    expect(tracker.isSleeping(4)).toBe(true);

    tracker.wake(4);

    expect(tracker.isSleeping(4)).toBe(false);
    advance(5 * MINUTE - 1);
    expect(tracker.isSleeping(4)).toBe(false);
    advance(1);
    expect(tracker.isSleeping(4)).toBe(true);
  });

  it("keeps the idle clock running when the same visibility is re-declared", () => {
    const { tracker, advance } = trackerFixture("5");
    tracker.observe([9], false);

    advance(4 * MINUTE);
    tracker.observe([9], false);
    advance(MINUTE);

    expect(tracker.isSleeping(9)).toBe(true);
  });

  it("restarts the idle clock when a pane is hidden again after being visible", () => {
    const { tracker, advance } = trackerFixture("5");
    tracker.observe([9], false);
    advance(4 * MINUTE);

    tracker.observe([9], true);
    tracker.observe([9], false);
    advance(4 * MINUTE);

    expect(tracker.isSleeping(9)).toBe(false);
    advance(MINUTE);
    expect(tracker.isSleeping(9)).toBe(true);
  });

  it("forgets released panes", () => {
    const { tracker, advance } = trackerFixture("5");
    tracker.observe([1, 2], false);
    advance(5 * MINUTE);
    expect([...tracker.sleepingSessions()].sort()).toEqual([1, 2]);

    tracker.release([1]);

    expect([...tracker.sleepingSessions()]).toEqual([2]);
    expect(tracker.isSleeping(1)).toBe(false);
  });

  it("reports the soonest pending deadline and nothing once everything sleeps", () => {
    const { tracker, advance } = trackerFixture("15");
    tracker.observe([1], false);
    advance(10 * MINUTE);
    tracker.observe([2], false);

    expect(tracker.msUntilNextSleep()).toBe(5 * MINUTE);

    advance(5 * MINUTE);
    expect(tracker.msUntilNextSleep()).toBe(10 * MINUTE);

    advance(10 * MINUTE);
    expect(tracker.msUntilNextSleep()).toBeNull();
  });

  it("re-evaluates already-idle panes when the setting changes", () => {
    const { tracker, advance } = trackerFixture("60");
    tracker.observe([5], false);
    advance(10 * MINUTE);
    expect(tracker.isSleeping(5)).toBe(false);

    tracker.setOption("5");
    expect(tracker.sleepOption).toBe("5");
    expect(tracker.isSleeping(5)).toBe(true);

    tracker.setOption("off");
    expect(tracker.isSleeping(5)).toBe(false);
  });
});

interface ScheduledRun {
  callback: () => void;
  delayMs: number;
  canceled: boolean;
}

function controllerFixture(option: SleepOption) {
  let now = 5_000_000;
  const scheduled: ScheduledRun[] = [];
  const controller = new SleepController({
    option,
    now: () => now,
    schedule: (callback, delayMs) => {
      const entry: ScheduledRun = { callback, delayMs, canceled: false };
      scheduled.push(entry);
      return () => {
        entry.canceled = true;
      };
    },
  });
  return {
    controller,
    scheduled,
    pending: () => scheduled.filter((entry) => !entry.canceled),
    advance(ms: number) {
      now += ms;
    },
    runDue() {
      const due = scheduled.filter((entry) => !entry.canceled);
      for (const entry of due) {
        entry.canceled = true;
        entry.callback();
      }
    },
  };
}

describe("SleepController", () => {
  it("publishes a stable snapshot and notifies only on membership changes", () => {
    const fixture = controllerFixture("5");
    const listener = vi.fn();
    fixture.controller.subscribe(listener);

    fixture.controller.observe([1], false);
    expect(listener).not.toHaveBeenCalled();
    const before = fixture.controller.getSnapshot();

    fixture.advance(5 * MINUTE);
    fixture.runDue();

    expect(listener).toHaveBeenCalledOnce();
    expect([...fixture.controller.getSnapshot()]).toEqual([1]);
    expect(fixture.controller.getSnapshot()).not.toBe(before);
    expect(fixture.controller.isSleeping(1)).toBe(true);

    const stable = fixture.controller.getSnapshot();
    fixture.controller.observe([1], false);
    expect(fixture.controller.getSnapshot()).toBe(stable);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("arms a timer for the next deadline and re-arms after each change", () => {
    const fixture = controllerFixture("15");

    fixture.controller.observe([1], false);
    expect(fixture.pending()).toHaveLength(1);
    expect(fixture.pending()[0]?.delayMs).toBe(15 * MINUTE);

    fixture.advance(10 * MINUTE);
    fixture.controller.observe([2], false);
    const pending = fixture.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.delayMs).toBe(5 * MINUTE);
  });

  it("arms no timer while the setting is off and re-arms when it changes", () => {
    const fixture = controllerFixture("off");
    fixture.controller.observe([1], false);
    expect(fixture.pending()).toHaveLength(0);

    fixture.controller.setOption("5");

    expect(fixture.pending()).toHaveLength(1);
    expect(fixture.pending()[0]?.delayMs).toBe(5 * MINUTE);
  });

  it("drops a released pane from the published snapshot", () => {
    const fixture = controllerFixture("5");
    fixture.controller.observe([1, 2], false);
    fixture.advance(5 * MINUTE);
    fixture.runDue();
    expect([...fixture.controller.getSnapshot()].sort()).toEqual([1, 2]);

    fixture.controller.release([1, 2]);

    expect([...fixture.controller.getSnapshot()]).toEqual([]);
  });

  it("keeps notifying other subscribers when one of them throws", () => {
    const fixture = controllerFixture("5");
    const healthy = vi.fn();
    fixture.controller.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    fixture.controller.subscribe(healthy);

    fixture.controller.observe([1], false);
    fixture.advance(5 * MINUTE);
    fixture.runDue();

    expect(healthy).toHaveBeenCalledOnce();
  });

  it("cancels its timer and stops publishing once disposed", () => {
    const fixture = controllerFixture("5");
    const listener = vi.fn();
    fixture.controller.subscribe(listener);
    fixture.controller.observe([1], false);

    fixture.controller.dispose();

    expect(fixture.pending()).toHaveLength(0);
    fixture.advance(10 * MINUTE);
    fixture.controller.observe([1], false);
    expect([...fixture.controller.getSnapshot()]).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});
