// @vitest-environment node
/// <reference types="node" />
/**
 * T8 ship-gate: kill the UI, relaunch, reattach — scrollback, layout, and
 * session lifecycle survive because they live in termx-host, not the UI.
 *
 * Layer split (docs/memos/2026-07-23-t8-e2e-architecture.md):
 *   L1 (host/tests/e2e.rs) proves the host survives a TRUE abrupt socket
 *   drop — no close frame — with scrollback intact.
 *   L2 (this file) proves the SHIPPING TypeScript transport rebuilds state
 *   from a real host over a real WebSocket. Two HostClients play the killed
 *   and relaunched UI processes against one spawned termx-host.exe.
 *
 * Client A "dies" via close(): the standard WebSocket API in Node cannot
 * sever TCP without sending a close frame. The host tears down forwarders
 * identically for a close frame and a reset (the reset path is L1's), so the
 * state-reconstruction claim this layer owns is unaffected.
 *
 * Markers are planted so the contiguous marker text can only come from
 * command OUTPUT, never from the echo of the typed line: cmd's caret escape
 * (TERMX^_...) and PowerShell's string concatenation ("TERMX" + "_...") keep
 * the input line non-matching. A match therefore proves the shell executed
 * the command and its output landed in the host's ring.
 *
 * Run from ui/:  npx vitest run --config vitest.e2e.config.ts
 * Requires:      cargo build -p termx-host  (spawns target/debug/termx-host.exe)
 *
 * Cases 1, 2, 5 are ship-gates; 3 and 4 ride along on the same story
 * (create → kill → relaunch → dismiss), so later cases depend on case 1.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HostClient,
  type LostScrollbackEvent,
  type SessionAttachment,
  type SessionAttachmentCallbacks,
} from "../client";
import type { JsonValue, SessionInfo } from "../protocol";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const HOST_EXE = path.join(REPO_ROOT, "target", "debug", "termx-host.exe");

const CMD_MARKER = "TERMX_E2E_CMD_MARK";
const PS_MARKER = "TERMX_E2E_PS_MARK";
const LIVE_MARKER = "TERMX_E2E_LIVE_MARK";

interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
}

/** Accumulates everything one attachment sees, for polling assertions. */
interface Collector {
  text: string;
  sources: Array<"replay" | "live">;
  lost: LostScrollbackEvent[];
  exitCode: number | null | undefined;
  callbacks: SessionAttachmentCallbacks;
}

function makeCollector(): Collector {
  const collector: Collector = {
    text: "",
    sources: [],
    lost: [],
    exitCode: undefined,
    callbacks: {},
  };
  collector.callbacks = {
    onOutput: (event) => {
      // latin1 keeps the byte→char mapping 1:1, so ASCII marker searches are
      // immune to escape sequences that would be invalid UTF-8.
      collector.text += Buffer.from(event.data).toString("latin1");
      collector.sources.push(event.source);
    },
    onLostScrollback: (event) => collector.lost.push(event),
    onExit: (code) => {
      collector.exitCode = code;
    },
  };
  return collector;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

async function waitForMarker(
  collector: Collector,
  marker: string,
  timeoutMs = 25_000,
): Promise<void> {
  try {
    await waitFor(`marker ${marker}`, () => collector.text.includes(marker), timeoutMs);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}; last output: ${JSON.stringify(collector.text.slice(-300))}`,
    );
  }
}

async function waitForSession(
  client: HostClient,
  sessionId: number,
  what: string,
  predicate: (info: SessionInfo | undefined) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sessions = await client.listSessions();
    if (predicate(sessions.find((session) => session.id === sessionId))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

function pidAlive(pid: number): boolean {
  const csv = execFileSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8" },
  );
  return csv.includes(`"${pid}"`);
}

describe("T8: kill UI → relaunch → reattach (real host, real transport)", () => {
  let host: ChildProcess | undefined;
  let dataDir = "";
  let runtimePath = "";
  let runtimeAtBoot: Buffer;
  let runtime: RuntimeInfo;

  let clientA: HostClient | null = null;
  let clientB: HostClient | null = null;
  let cmdId = -1;
  let psId = -1;
  let layoutBlob: JsonValue = null;
  let pidAliveAfterDrop = false;
  let runtimeAfterDrop: Buffer | null = null;
  let bCmd: { attachment: SessionAttachment; collector: Collector } | null = null;

  function connectClient(): Promise<HostClient> {
    return HostClient.connect({
      port: runtime.port,
      token: runtime.token,
      // Node 24's global (undici) WebSocket — the same seam unit tests fake.
      webSocketFactory: (url) => new WebSocket(url),
    });
  }

  beforeAll(async () => {
    expect(
      existsSync(HOST_EXE),
      `missing ${HOST_EXE} — run: cargo build -p termx-host`,
    ).toBe(true);

    dataDir = mkdtempSync(path.join(tmpdir(), "termx-e2e-"));
    runtimePath = path.join(dataDir, "runtime.json");
    host = spawn(HOST_EXE, ["--data-dir", dataDir], {
      stdio: "ignore",
      windowsHide: true,
    });

    let raw: Buffer | null = null;
    let parsed: RuntimeInfo | null = null;
    await waitFor(
      "runtime.json discovery state",
      () => {
        try {
          const bytes = readFileSync(runtimePath);
          const value = JSON.parse(bytes.toString("utf8")) as RuntimeInfo;
          if (
            typeof value.port === "number"
            && value.port > 0
            && typeof value.token === "string"
            && value.token.length > 0
            && typeof value.pid === "number"
          ) {
            raw = bytes;
            parsed = value;
            return true;
          }
        } catch {
          // not yet written, or caught mid-write — keep polling
        }
        return false;
      },
      20_000,
    );
    runtimeAtBoot = raw!;
    runtime = parsed!;
    expect(runtime.pid).toBe(host.pid);
  }, 60_000);

  afterAll(async () => {
    if (!host) {
      return;
    }
    // A failed case can leave A connected; drop it so only teardown remains.
    try {
      clientA?.close();
    } catch {
      // already closed
    }

    let shutdownRequested = false;
    try {
      if (clientB) {
        clientB.shutdown();
        shutdownRequested = true;
      }
    } catch {
      // connection already gone — fall through to a parting client
    }
    if (!shutdownRequested) {
      try {
        const parting = await connectClient();
        parting.shutdown();
        shutdownRequested = true;
      } catch {
        // host may already be down; the pid poll below decides
      }
    }

    let orphaned = false;
    try {
      await waitFor(
        "termx-host to exit after Shutdown",
        () => !pidAlive(host!.pid!),
        15_000,
        250,
      );
    } catch {
      orphaned = true;
      try {
        execFileSync("taskkill", ["/PID", String(host.pid), "/F", "/T"]);
      } catch {
        // died between the poll and the kill
      }
    }
    try {
      clientB?.close();
    } catch {
      // socket died with the host
    }
    clientB = null;

    const runtimeGone = !existsSync(runtimePath);

    // Give the exited host a beat to release log handles before deleting.
    await sleep(200);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      await sleep(500);
      rmSync(dataDir, { recursive: true, force: true });
    }

    if (orphaned) {
      throw new Error("termx-host did not exit after Shutdown — orphan force-killed");
    }
    if (shutdownRequested && !runtimeGone) {
      throw new Error("runtime.json survived a clean Shutdown");
    }
  }, 60_000);

  it("1. reattach reconstructs both sessions' scrollback (ship-gate)", async () => {
    clientA = await connectClient();
    expect(clientA.initialSessions).toEqual([]);

    const cmd = await clientA.createSession({
      profile: "cmd",
      cwd: null,
      cols: 100,
      rows: 30,
    });
    const ps = await clientA.createSession({
      profile: "powershell",
      cwd: null,
      cols: 100,
      rows: 30,
    });
    cmdId = cmd.id;
    psId = ps.id;
    expect(cmd.alive).toBe(true);
    expect(ps.alive).toBe(true);

    // Attaches must be sequential — attach errors carry no session id.
    const aCmd = makeCollector();
    const aCmdHandle = await clientA.attach(cmd.id, aCmd.callbacks);
    const aPs = makeCollector();
    const aPsHandle = await clientA.attach(ps.id, aPs.callbacks);

    await waitFor("cmd first output", () => aCmd.text.length > 0);
    aCmdHandle.sendInput("echo TERMX^_E2E_CMD_MARK\r");
    await waitForMarker(aCmd, CMD_MARKER);

    await waitFor("powershell first output", () => aPs.text.length > 0);
    aPsHandle.sendInput('"TERMX" + "_E2E_PS_MARK"\r');
    await waitForMarker(aPs, PS_MARKER);

    // Layout for case 3 — a synchronous durable persist on the host.
    layoutBlob = {
      version: 1,
      groups: [
        {
          id: "g1",
          name: "E2E",
          color: "#7aa2f7",
          tabs: [
            { id: "t1", title: "cmd", tree: { kind: "leaf", session: cmd.id } },
          ],
        },
      ],
    };
    await clientA.setLayout(layoutBlob);

    // "Kill the UI": drop A without detaching anything (see header on close
    // frames). Evidence for case 2 is captured while no client is connected.
    clientA.close();
    clientA = null;
    pidAliveAfterDrop = pidAlive(runtime.pid);
    runtimeAfterDrop = readFileSync(runtimePath);

    // "Relaunch": a brand-new transport from the same discovery material.
    clientB = await connectClient();
    const byId = new Map(clientB.initialSessions.map((session) => [session.id, session]));
    expect(byId.get(cmd.id)?.alive).toBe(true);
    expect(byId.get(ps.id)?.alive).toBe(true);

    const bCmdCollector = makeCollector();
    const bCmdHandle = await clientB.attach(cmd.id, bCmdCollector.callbacks);
    bCmd = { attachment: bCmdHandle, collector: bCmdCollector };
    const bPs = makeCollector();
    await clientB.attach(ps.id, bPs.callbacks);

    // Replay may arrive in multiple chunks — poll, don't trust the first.
    await waitForMarker(bCmdCollector, CMD_MARKER, 10_000);
    await waitForMarker(bPs, PS_MARKER, 10_000);
    expect(bCmdCollector.sources[0]).toBe("replay");
    expect(bPs.sources[0]).toBe("replay");
  }, 90_000);

  it("2. host outlived the UI drop (ship-gate)", () => {
    expect(runtimeAfterDrop, "case 1 must pass first").not.toBeNull();
    expect(pidAliveAfterDrop).toBe(true);
    // Byte-identical discovery state — same host, never respawned...
    expect(runtimeAfterDrop!.equals(runtimeAtBoot)).toBe(true);
    // ...and it is exactly the process this suite spawned.
    expect(runtime.pid).toBe(host!.pid);
  });

  it("3. layout survives the UI drop", async () => {
    expect(clientB, "case 1 must pass first").not.toBeNull();
    const state = await clientB!.getState();
    expect(state.layout).toEqual(layoutBlob);
    const ids = state.sessions.map((session) => session.id).sort((a, b) => a - b);
    expect(ids).toEqual([cmdId, psId].sort((a, b) => a - b));
  });

  it("4. replay→live handoff is gapless", async () => {
    expect(bCmd, "case 1 must pass first").not.toBeNull();
    const { attachment, collector } = bCmd!;
    const replayLength = collector.text.length;

    attachment.sendInput("echo TERMX^_E2E_LIVE_MARK\r");
    await waitForMarker(collector, LIVE_MARKER);

    expect(collector.text.length).toBeGreaterThan(replayLength);
    expect(collector.sources).toContain("live");
    // No onLostScrollback at the replay/live boundary: overlap-trim against a
    // real ring produced a contiguous stream.
    expect(collector.lost).toEqual([]);
  });

  it("5. dead-tab dismissal frees the session (ship-gate)", async () => {
    expect(clientB, "case 1 must pass first").not.toBeNull();
    expect(bCmd, "case 1 must pass first").not.toBeNull();
    const client = clientB!;
    const exited: number[] = [];
    client.onSessionExited((event) => exited.push(event.sessionId));

    bCmd!.attachment.sendInput("exit\r");
    await waitForSession(
      client,
      cmdId,
      "cmd session to report alive:false",
      (info) => info?.alive === false,
    );
    // The registry flips alive:false before the forwarder task's
    // session_exited push reaches the socket — poll, don't assert instantly.
    await waitFor("session_exited notification", () => exited.includes(cmdId), 10_000);
    await waitFor(
      "onExit callback on the attachment",
      () => bCmd!.collector.exitCode !== undefined,
      10_000,
    );
    expect(bCmd!.collector.exitCode).toBe(0);

    // Dismissing the dead tab must actually free the host-side ring
    // (BACKLOG §5): CloseSession, then the session vanishes from listings.
    await client.closeSession(cmdId);
    const after = await client.listSessions();
    expect(after.find((session) => session.id === cmdId)).toBeUndefined();
    expect(after.find((session) => session.id === psId)?.alive).toBe(true);
  }, 60_000);
});
