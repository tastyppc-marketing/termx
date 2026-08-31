import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled";
import { ensureUp, isHealthy, parseRuntimeFile } from "../lifecycle";
import type { PluginNative } from "../native";

const MANIFEST = BUNDLED_MANIFESTS.showroom;
const PLUGIN_PATH = "C:\\Plugins\\Showroom";
const ENV = { APPDATA: "C:\\Users\\test\\AppData\\Roaming" };
const RUNTIME_PATH = "C:\\Users\\test\\AppData\\Roaming\\Showroom\\runtime.json";
const DEFAULT_PORT = 7317;
const HEALTH_URL = `http://127.0.0.1:${DEFAULT_PORT}/api/health`;
const POLL_MS = 250;
/** The runtime file and the live process report versions independently. */
const FILE_VERSION = "1.0.0";
const LIVE_VERSION = "2.0.0";

function runtimeText(
  token: string,
  options: { port?: number; pid?: number; version?: string | null } = {},
): string {
  const version = options.version === undefined ? FILE_VERSION : options.version;
  const body: Record<string, unknown> = {
    port: options.port ?? DEFAULT_PORT,
    token,
    pid: options.pid ?? 4242,
  };
  if (version !== null) {
    body.version = version;
  }
  return JSON.stringify(body);
}

function healthText(
  version: string | null = LIVE_VERSION,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    version === null ? { ok: true, ...extra } : { ok: true, version, ...extra },
  );
}

/** The shape Showroom's own `/api/health` returns, extra keys and all. */
const SHOWROOM_HEALTH = healthText(LIVE_VERSION, {
  counts: { artifacts: 128, folders: 9 },
  lastScan: "2026-08-30T23:10:00.000Z",
  scanState: "idle",
  watch: { active: true },
});

/** Spec §2: every plugin process is stamped as TermX-started. */
const SPAWN_ENV = { TERMX: "1", TERMX_PLUGIN_ID: "showroom" };

type SpawnCall = [string, string[], string, Record<string, string> | undefined];

interface FakeNative extends PluginNative {
  readonly calls: string[];
  readonly spawns: SpawnCall[];
}

/**
 * Scripted native: answers are functions of the call index so a test can say
 * "the runtime file only appears on the second poll" without timing games.
 * Any script function may THROW to simulate the Rust side returning `Err`,
 * which is a different answer from a missing runtime file (`null`).
 */
function createNative(script: {
  runtime?: (call: number) => string | null;
  probe?: (call: number) => string;
  spawn?: () => number;
  stderrTail?: () => string;
}): FakeNative {
  const calls: string[] = [];
  const spawns: SpawnCall[] = [];
  let reads = 0;
  let probes = 0;
  return {
    calls,
    spawns,
    // Settings-only seam; ensure-up never reads a manifest, so a call here is a
    // test failure, not an answer.
    async readManifest() {
      throw new Error("ensureUp must not read manifests");
    },
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
    async spawn(command, args, cwd, env) {
      calls.push("spawn");
      spawns.push([command, [...args], cwd, env ? { ...env } : undefined]);
      return script.spawn ? script.spawn() : 4242;
    },
    async stderrTail(pid) {
      calls.push(`stderrTail:${pid}`);
      return script.stderrTail ? script.stderrTail() : "";
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
      version: FILE_VERSION,
    });
  });

  it("accepts a runtime file that omits the version", () => {
    expect(parseRuntimeFile(runtimeText("tok-1", { version: null }))).toEqual({
      port: 7317,
      token: "tok-1",
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

  it("accepts the extra fields Showroom's health route reports", () => {
    expect(isHealthy(SHOWROOM_HEALTH)).toBe(true);
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
        version: LIVE_VERSION,
        url: "http://127.0.0.1:7317",
      },
    });
    expect(native.calls).toEqual([
      `readRuntime:${RUNTIME_PATH}`,
      `probe:${HEALTH_URL}`,
    ]);
    expect(native.spawns).toHaveLength(0);
  });

  it("builds the url and probe target from the recorded port", async () => {
    const native = createNative({
      // Showroom's real default port, and it walks upward from there.
      runtime: () => runtimeText("tok-1", { port: 7345 }),
      probe: () => SHOWROOM_HEALTH,
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    expect(result).toMatchObject({
      ok: true,
      runtime: { port: 7345, url: "http://127.0.0.1:7345" },
    });
    expect(native.calls).toContain("probe:http://127.0.0.1:7345/api/health");
  });

  it("reports the version the live process answers with, not the file's", async () => {
    const native = createNative({
      runtime: () => runtimeText("tok-1", { version: FILE_VERSION }),
      probe: () => healthText(LIVE_VERSION),
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    expect(result).toMatchObject({ ok: true, runtime: { version: "2.0.0" } });
  });

  it("adopts the live version when the runtime file carries none", async () => {
    const native = createNative({
      runtime: () => runtimeText("tok-1", { version: null }),
      probe: () => healthText(LIVE_VERSION),
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    expect(result).toMatchObject({ ok: true, runtime: { version: "2.0.0" } });
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
        version: LIVE_VERSION,
        url: "http://127.0.0.1:7317",
      },
    });
    expect(native.spawns).toEqual([
      ["node", ["server/showroom.js"], PLUGIN_PATH, SPAWN_ENV],
    ]);
  });

  it("stamps the TermX identity variables on the spawned process", async () => {
    vi.useFakeTimers();
    const native = createNative({
      runtime: (call) => (call === 0 ? null : runtimeText("tok-env")),
      probe: () => healthText(),
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));
    await pollTimes(2);
    await pending;

    // Spec §2: the plugin must be able to tell TermX started it, and which
    // registry id it was started as. `id`, never `name` — the id is the key.
    expect(native.spawns[0]?.[3]).toEqual({
      TERMX: "1",
      TERMX_PLUGIN_ID: "showroom",
    });
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

  it("fails with the stderr tail of the process it spawned", async () => {
    vi.useFakeTimers();
    const native = createNative({
      // The runtime file names a DIFFERENT pid: a singleton's recorded pid is
      // not the process TermX spawned, and only the latter has a captured log.
      runtime: () => runtimeText("tok-4", { pid: 4242 }),
      spawn: () => 99,
      stderrTail: () => "Error: listen EADDRINUSE 127.0.0.1:7317",
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
    expect(native.calls).toContain("stderrTail:99");
    expect(native.calls).not.toContain("stderrTail:4242");
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

  it("fails fast when the runtime path itself is unreadable", async () => {
    const native = createNative({
      runtime: () => {
        throw new Error("plugin runtime path must be absolute");
      },
    });

    const result = await ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));

    // A rejected read is a configuration/IO fault, not "the plugin is down":
    // spawning and burning the full 10 s budget on it hides the real error.
    expect(result).toEqual({
      ok: false,
      reason: "plugin runtime path must be absolute",
      stderrTail: "",
    });
    expect(native.spawns).toHaveLength(0);
    expect(countCalls(native, "probe")).toBe(0);
  });

  it("keeps polling when a read fails while the plugin is writing the file", async () => {
    vi.useFakeTimers();
    const native = createNative({
      runtime: (call) => {
        if (call === 0) {
          return null;
        }
        if (call === 1) {
          throw new Error("reading runtime.json: The process cannot access the file");
        }
        return runtimeText("tok-6");
      },
      probe: () => healthText(),
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native));
    await pollTimes(3);
    const result = await pending;

    expect(result).toMatchObject({ ok: true, runtime: { token: "tok-6" } });
  });

  it("survives a stderr tail that rejects", async () => {
    vi.useFakeTimers();
    const native = createNative({
      runtime: () => runtimeText("tok-7"),
      stderrTail: () => {
        throw new Error("log file vanished");
      },
    });

    const pending = ensureUp(MANIFEST, PLUGIN_PATH, depsFor(native, 500));
    await pollTimes(3);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      reason: "health probe never passed",
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
