import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled";
import { ensureUp, isHealthy, parseRuntimeFile } from "../lifecycle";
import type { PluginNative } from "../native";

const MANIFEST = BUNDLED_MANIFESTS.showroom;
const PLUGIN_PATH = "C:\\Plugins\\Showroom";
const ENV = { APPDATA: "C:\\Users\\test\\AppData\\Roaming" };
const RUNTIME_PATH = "C:\\Users\\test\\AppData\\Roaming\\Showroom\\runtime.json";
const HEALTH_URL = "http://127.0.0.1:7317/api/health";
const POLL_MS = 250;

function runtimeText(token: string, port = 7317): string {
  return JSON.stringify({ port, token, pid: 4242, version: "1.4.0" });
}

function healthText(version: string | null = "1.4.0"): string {
  return version === null
    ? JSON.stringify({ ok: true })
    : JSON.stringify({ ok: true, version });
}

interface FakeNative extends PluginNative {
  readonly calls: string[];
  readonly spawns: [string, string[], string][];
}

/**
 * Scripted native: answers are functions of the call index so a test can say
 * "the runtime file only appears on the second poll" without timing games.
 */
function createNative(script: {
  runtime?: (call: number) => string | null;
  probe?: (call: number) => string;
  spawn?: () => number;
  stderrTail?: string;
}): FakeNative {
  const calls: string[] = [];
  const spawns: [string, string[], string][] = [];
  let reads = 0;
  let probes = 0;
  return {
    calls,
    spawns,
    async readRuntime(path) {
      calls.push(`readRuntime:${path}`);
      return script.runtime ? script.runtime(reads++) : null;
    },
    async probe(url) {
      calls.push(`probe:${url}`);
      const answer = script.probe?.(probes++);
      if (answer === undefined) {
        throw new Error("connection refused");
      }
      return answer;
    },
    async spawn(command, args, cwd) {
      calls.push("spawn");
      spawns.push([command, [...args], cwd]);
      return script.spawn ? script.spawn() : 4242;
    },
    async stderrTail(pid) {
      calls.push(`stderrTail:${pid}`);
      return script.stderrTail ?? "";
    },
  };
}

function depsFor(native: FakeNative, spawnTimeoutMs?: number) {
  return {
    native,
    env: ENV,
    now: () => Date.now(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    ...(spawnTimeoutMs === undefined ? {} : { spawnTimeoutMs }),
  };
}

/** Drive the poll loop one interval at a time so pending timers are flushed. */
async function pollTimes(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  }
}

function countCalls(native: FakeNative, prefix: string): number {
  return native.calls.filter((call) => call.startsWith(prefix)).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime file parsing", () => {
  it("reads port and token from a well-formed runtime file", () => {
    expect(parseRuntimeFile(runtimeText("tok-1"))).toEqual({
      port: 7317,
      token: "tok-1",
      version: "1.4.0",
    });
  });

  it.each([
    ["a missing file", null],
    ["invalid JSON", "{oops"],
    ["a missing port", JSON.stringify({ token: "tok-1" })],
    ["a non-numeric port", JSON.stringify({ port: "7317", token: "tok-1" })],
    ["an out-of-range port", JSON.stringify({ port: 99999, token: "tok-1" })],
    ["a missing token", JSON.stringify({ port: 7317 })],
  ])("returns null for %s", (_label, text) => {
    expect(parseRuntimeFile(text)).toBeNull();
  });
});

describe("health identity", () => {
  it("requires ok true and a version string", () => {
    expect(isHealthy(healthText())).toBe(true);
    expect(isHealthy(healthText(null))).toBe(false);
    expect(isHealthy(JSON.stringify({ ok: false, version: "1.4.0" }))).toBe(
      false,
    );
    expect(isHealthy("not json")).toBe(false);
  });
});

describe("ensureUp", () => {
  it("adopts an already healthy plugin without spawning", async () => {
    const native = createNative({
      runtime: () => runtimeText("tok-1"),
      probe: () => healthText(),
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    expect(result).toEqual({
      ok: true,
      runtime: {
        port: 7317,
        token: "tok-1",
        version: "1.4.0",
        url: "http://127.0.0.1:7317",
      },
    });
    expect(native.calls).toEqual([
      `readRuntime:${RUNTIME_PATH}`,
      `probe:${HEALTH_URL}`,
    ]);
    expect(native.spawns).toHaveLength(0);
  });

  it("spawns once and adopts the runtime that appears on a later poll", async () => {
    vi.useFakeTimers();
    const native = createNative({
      // No runtime file until the second poll, then a refused probe, then up.
      runtime: (call) => (call < 2 ? null : runtimeText("tok-2")),
      probe: (call) => {
        if (call === 0) {
          throw new Error("connection refused");
        }
        return healthText();
      },
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));
    await pollTimes(4);
    const result = await pending;

    expect(result).toEqual({
      ok: true,
      runtime: {
        port: 7317,
        token: "tok-2",
        version: "1.4.0",
        url: "http://127.0.0.1:7317",
      },
    });
    expect(native.spawns).toEqual([
      ["node", ["server/showroom.js"], PLUGIN_PATH],
    ]);
  });

  it("treats a health body without a version as not up and spawns", async () => {
    vi.useFakeTimers();
    const native = createNative({
      runtime: () => runtimeText("tok-3"),
      probe: (call) => (call === 0 ? healthText(null) : healthText()),
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));
    await pollTimes(2);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(native.spawns).toHaveLength(1);
  });

  it("fails with the stderr tail when the probe never passes", async () => {
    vi.useFakeTimers();
    const native = createNative({
      runtime: () => runtimeText("tok-4"),
      stderrTail: "Error: listen EADDRINUSE 127.0.0.1:7317",
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));
    await pollTimes(41);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      reason: "health probe never passed",
      stderrTail: "Error: listen EADDRINUSE 127.0.0.1:7317",
    });
    expect(native.spawns).toHaveLength(1);
    // One pre-spawn attempt plus a 250 ms poll across the full 10 s budget.
    expect(countCalls(native, "readRuntime")).toBe(41);
    expect(native.calls).toContain("stderrTail:4242");
  });

  it("honours a shorter spawn timeout", async () => {
    vi.useFakeTimers();
    const native = createNative({ runtime: () => runtimeText("tok-5") });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native, 500));
    await pollTimes(3);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(countCalls(native, "readRuntime")).toBe(3);
  });

  it("reports a spawn that throws without waiting for the timeout", async () => {
    const native = createNative({
      spawn: () => {
        throw new Error("ENOENT: node not found");
      },
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    expect(result).toEqual({
      ok: false,
      reason: "ENOENT: node not found",
      stderrTail: "",
    });
  });

  it("re-reads a rotated token on every ensureUp", async () => {
    const native = createNative({
      runtime: (call) => runtimeText(call === 0 ? "tok-boot-1" : "tok-boot-2"),
      probe: () => healthText(),
    });
    const deps = depsFor(native);

    const first = await ensureUp(MANIFEST, PLUGIN_PATH, deps);
    const second = await ensureUp(MANIFEST, PLUGIN_PATH, deps);

    expect(first.ok && first.runtime.token).toBe("tok-boot-1");
    expect(second.ok && second.runtime.token).toBe("tok-boot-2");
  });
});
