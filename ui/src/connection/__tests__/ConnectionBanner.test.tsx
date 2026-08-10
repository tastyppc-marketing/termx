import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner, STILL_TRYING_MS } from "../ConnectionBanner";
import {
  listenForPowerEvents,
  POWER_RESUME_EVENT,
  POWER_SUSPEND_EVENT,
} from "../powerEvents";

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
  vi.useRealTimers();
});

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => root.render(ui));
}

function banner(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='connection-banner']");
}

function bannerText(): string {
  const element = banner();
  if (!element) {
    throw new Error("banner is not rendered");
  }
  return element.textContent ?? "";
}

describe("ConnectionBanner", () => {
  it("stays silent while connected", async () => {
    await render(<ConnectionBanner state={{ phase: "connected" }} onRetry={() => undefined} />);
    expect(banner()).toBeNull();
  });

  it("stays silent during the very first connect of the session", async () => {
    await render(
      <ConnectionBanner
        state={{ phase: "connecting", isInitial: true }}
        onRetry={() => undefined}
      />,
    );
    expect(banner()).toBeNull();
  });

  it("names the attempt while reconnecting", async () => {
    await render(
      <ConnectionBanner
        state={{ phase: "reconnecting", attempt: 3, nextDelayMs: 5_000 }}
        onRetry={() => undefined}
      />,
    );
    expect(bannerText()).toContain("Reconnecting to host… (attempt 3)");
    expect(container.querySelector("button")).toBeNull();
  });

  it("speaks up during a reconnect attempt that is in flight", async () => {
    await render(
      <ConnectionBanner
        state={{ phase: "connecting", isInitial: false }}
        onRetry={() => undefined}
      />,
    );
    expect(bannerText()).toContain("Reconnecting to host…");
  });

  it("softens its claim after two continuous minutes, without giving up", async () => {
    vi.useFakeTimers();
    await render(
      <ConnectionBanner
        state={{ phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 }}
        onRetry={() => undefined}
      />,
    );

    // Individual attempts must not restart the outage clock.
    await act(async () => {
      vi.advanceTimersByTime(STILL_TRYING_MS - 1);
    });
    await render(
      <ConnectionBanner
        state={{ phase: "reconnecting", attempt: 9, nextDelayMs: 10_000 }}
        onRetry={() => undefined}
      />,
    );
    expect(bannerText()).not.toContain("still trying");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(bannerText()).toContain("(attempt 9) — still trying");
  });

  it("offers the restart action only when the bootstrap itself failed", async () => {
    const onRetry = vi.fn();
    await render(
      <ConnectionBanner
        state={{ phase: "failed", reason: "termx-host.exe is missing" }}
        onRetry={onRetry}
      />,
    );

    expect(bannerText()).toContain("Host connection failed — termx-host.exe is missing");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Restart host");
    await act(async () => {
      button!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("clears the still-trying label once the host comes back", async () => {
    vi.useFakeTimers();
    await render(
      <ConnectionBanner
        state={{ phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 }}
        onRetry={() => undefined}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(STILL_TRYING_MS);
    });
    expect(bannerText()).toContain("still trying");

    await render(<ConnectionBanner state={{ phase: "connected" }} onRetry={() => undefined} />);
    expect(banner()).toBeNull();

    await render(
      <ConnectionBanner
        state={{ phase: "reconnecting", attempt: 1, nextDelayMs: 1_000 }}
        onRetry={() => undefined}
      />,
    );
    expect(bannerText()).not.toContain("still trying");
  });
});

describe("power event bridge", () => {
  function fakeListen() {
    const handlers = new Map<string, () => void>();
    const stops = new Map<string, ReturnType<typeof vi.fn>>();
    const listen = vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
      const stop = vi.fn();
      stops.set(event, stop);
      return Promise.resolve(stop);
    });
    return { handlers, stops, listen };
  }

  it("routes suspend and resume into the reconnect machine", async () => {
    const { handlers, listen } = fakeListen();
    const connection = { notifySuspend: vi.fn(), notifyResume: vi.fn() };

    const stop = listenForPowerEvents(connection, listen);
    await Promise.resolve();

    handlers.get(POWER_SUSPEND_EVENT)!();
    handlers.get(POWER_RESUME_EVENT)!();

    expect(connection.notifySuspend).toHaveBeenCalledTimes(1);
    expect(connection.notifyResume).toHaveBeenCalledTimes(1);
    stop();
  });

  it("unsubscribes both events", async () => {
    const { stops, listen } = fakeListen();
    const stop = listenForPowerEvents(
      { notifySuspend: vi.fn(), notifyResume: vi.fn() },
      listen,
    );
    await Promise.resolve();
    await Promise.resolve();

    stop();

    expect(stops.get(POWER_SUSPEND_EVENT)!).toHaveBeenCalledTimes(1);
    expect(stops.get(POWER_RESUME_EVENT)!).toHaveBeenCalledTimes(1);
  });

  it("drops a subscription that lands after teardown", async () => {
    const stopSuspend = vi.fn();
    const listen = vi.fn(() => Promise.resolve(stopSuspend));
    const stop = listenForPowerEvents(
      { notifySuspend: vi.fn(), notifyResume: vi.fn() },
      listen,
    );

    stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopSuspend).toHaveBeenCalled();
  });

  it("degrades to plain backoff where there are no power events", async () => {
    const listen = vi.fn(() => Promise.reject(new Error("no shell here")));
    expect(() =>
      listenForPowerEvents({ notifySuspend: vi.fn(), notifyResume: vi.fn() }, listen),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
