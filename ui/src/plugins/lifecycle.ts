import { expandEnv, type PluginManifest } from "./manifest";
import type { PluginNative } from "./native";

export interface PluginRuntime {
  port: number;
  token: string;
  version: string;
  /** Origin only, no trailing slash, so `${url}${path}` composes cleanly. */
  url: string;
}

export type EnsureUpResult =
  | { ok: true; runtime: PluginRuntime }
  | { ok: false; reason: string; stderrTail: string };

export interface EnsureUpDeps {
  native: PluginNative;
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Budget for a freshly spawned plugin to answer its health route. */
  spawnTimeoutMs?: number;
}

export interface RuntimeFile {
  port: number;
  token: string;
  version?: string;
}

/**
 * How long a plugin gets to answer its health route after a spawn — and, for
 * a window that is not allowed to spawn, how long it waits for the window
 * that is. Exported so the two cannot drift apart.
 */
export const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
/** Exported for the same reason: an observer polls on the same beat. */
export const POLL_INTERVAL_MS = 250;
/** Loopback probes either answer at once or the port is not serving us. */
export const PROBE_TIMEOUT_MS = 1_000;
const MAX_PORT = 65_535;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A half-written or stale runtime file must read as "not up", never throw. */
export function parseRuntimeFile(text: string | null): RuntimeFile | null {
  if (text === null) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }

  const { port, token, version } = raw;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > MAX_PORT
  ) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return typeof version === "string" ? { port, token, version } : { port, token };
}

/**
 * The version string is what makes the probe identity-aware (spec §3.1): a
 * foreign app squatting on the recorded port can answer 200, so only the
 * `{ ok: true, version: "…" }` pair proves the plugin itself is listening.
 */
function healthVersion(body: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.ok !== true || typeof raw.version !== "string") {
    return null;
  }
  return raw.version;
}

export function isHealthy(body: string): boolean {
  return healthVersion(body) !== null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * A connect attempt either reaches the plugin, finds it down, or cannot even
 * ask. The third case is separate because `plugin_read_runtime` answers `null`
 * for a missing file but rejects for a non-absolute path, an oversize file or
 * an IO error — faults that spawning and polling can never resolve.
 */
type ConnectOutcome =
  | { kind: "up"; runtime: PluginRuntime }
  | { kind: "down" }
  | { kind: "unreadable"; reason: string };

/**
 * One connect attempt: the runtime file is re-read every time because plugins
 * rotate their token per boot (spec §3.5), so a cached token is wrong by design.
 */
async function connect(
  runtimePath: string,
  manifest: PluginManifest,
  deps: EnsureUpDeps,
): Promise<ConnectOutcome> {
  let text: string | null;
  try {
    text = await deps.native.readRuntime(runtimePath);
  } catch (error) {
    return { kind: "unreadable", reason: errorMessage(error) };
  }

  const file = parseRuntimeFile(text);
  if (file === null) {
    return { kind: "down" };
  }

  const url = `http://127.0.0.1:${file.port}`;
  let body: string;
  try {
    body = await deps.native.probe(
      `${url}${manifest.discovery.healthPath}`,
      PROBE_TIMEOUT_MS,
    );
  } catch {
    // A refused or timed-out probe is the ordinary "not listening yet" answer.
    return { kind: "down" };
  }

  const version = healthVersion(body);
  if (version === null) {
    return { kind: "down" };
  }
  return {
    kind: "up",
    runtime: { port: file.port, token: file.token, version, url },
  };
}

async function tailOf(native: PluginNative, pid: number): Promise<string> {
  try {
    return await native.stderrTail(pid);
  } catch {
    return "";
  }
}

/**
 * Ensure a plugin is reachable without owning its process (spec §3): adopt a
 * healthy instance, otherwise spawn and poll. A fast exit is NOT a failure —
 * a singleton exits 0 to say "already running" — so only the health probe
 * decides, and TermX never kills what it did not have to start.
 */
export async function ensureUp(
  manifest: PluginManifest,
  pluginPath: string,
  deps: EnsureUpDeps,
): Promise<EnsureUpResult> {
  const runtimePath = expandEnv(manifest.discovery.runtimeFile, deps.env);

  const adopted = await connect(runtimePath, manifest, deps);
  if (adopted.kind === "up") {
    return { ok: true, runtime: adopted.runtime };
  }
  if (adopted.kind === "unreadable") {
    // Fail fast: an unexpanded `%VAR%` path or a denied read cannot start
    // working because a process was spawned, and burning the whole spawn
    // budget on it would report "health probe never passed" for a path fault.
    return { ok: false, reason: adopted.reason, stderrTail: "" };
  }

  let pid: number;
  try {
    pid = await deps.native.spawn(
      manifest.start.command,
      [...manifest.start.args],
      pluginPath,
      // Spec §2: a plugin must be able to tell that TermX started it, and as
      // which registry id — the id is the key everything else is bound by.
      { TERMX: "1", TERMX_PLUGIN_ID: manifest.id },
    );
  } catch (error) {
    return { ok: false, reason: errorMessage(error), stderrTail: "" };
  }

  const deadline =
    deps.now() + (deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const polled = await connect(runtimePath, manifest, deps);
    if (polled.kind === "up") {
      return { ok: true, runtime: polled.runtime };
    }
    // A read that fails DURING the poll is not fatal the way the first one is:
    // the plugin is writing this very file, and Windows can hand back a
    // sharing violation mid-write on a launch that is about to succeed.
  }

  return {
    ok: false,
    reason: "health probe never passed",
    stderrTail: await tailOf(deps.native, pid),
  };
}
