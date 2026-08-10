// @vitest-environment node
/// <reference types="node" />
/**
 * Reliability ship-gate: the socket dies, the DAEMON DOES NOT, and the UI
 * stitches itself back onto the same running shell without showing the user a
 * single byte twice.
 *
 * This is the layer the unit tests cannot reach. `reconnect.test.ts` proves the
 * state machine against a fake clock and a fake client; this proves the whole
 * chain — ReconnectingHostClient over the real HostClient over a real WebSocket
 * against a real termx-host.exe, with a real ConPTY producing real bytes, and
 * an AttachmentHub resyncing from its own byte cursor.
 *
 * The drop is a socket close rather than a TCP reset because Node's WebSocket
 * cannot sever a connection without a close frame. The host tears down a
 * forwarder identically either way (the reset path is host/tests/e2e.rs), and
 * the claim this file owns — that the CLIENT rebuilds and resumes from its
 * cursor — is unaffected.
 *
 * The marker is planted so only command OUTPUT can match it: cmd's caret
 * escape (TERMX^_...) keeps the echoed input line non-matching. A marker that
 * appears exactly once therefore proves the resync replayed nothing the pane
 * had already seen.
 *
 * Run from ui/:  npx vitest run --config vitest.e2e.config.ts
 * Requires:      cargo build -p termx-host
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostClient } from "../client";
import {
  ANTI_FLAP_FLOOR_MS,
  ReconnectingHostClient,
  type ConnectionState,
} from "../reconnect";
import { AttachmentHub } from "../../workspace/AttachmentHub";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const HOST_EXE = path.join(REPO_ROOT, "target", "debug", "termx-host.exe");

const FIRST_MARKER = "TERMX_RECONNECT_BEFORE";
const SECOND_MARKER = "TERMX_RECONNECT_AFTER";

interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 20_000,
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

function pidAlive(pid: number): boolean {
  const csv = execFileSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8" },
  );
  return csv.includes(`"${pid}"`);
}

describe("reliability: socket drop → reconnect → resync (real host, real transport)", () => {
  let host: ChildProcess | undefined;
  let dataDir = "";
  let runtimePath = "";

  /** The live WebSocket of whichever HostClient the machine currently holds. */
  let liveSocket: WebSocket | null = null;
  let machine: ReconnectingHostClient<HostClient> | null = null;
  let hub: AttachmentHub | null = null;

  function readRuntime(): RuntimeInfo {
    return JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeInfo;
  }

  /** The FULL bootstrap chain, as the app runs it: re-read discovery, connect. */
  async function connect(): Promise<HostClient> {
    const runtime = readRuntime();
    return HostClient.connect({
      port: runtime.port,
      token: runtime.token,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        liveSocket = socket;
        return socket;
      },
    });
  }

  beforeAll(async () => {
    expect(
      existsSync(HOST_EXE),
      `missing ${HOST_EXE} — run: cargo build -p termx-host`,
    ).toBe(true);

    dataDir = mkdtempSync(path.join(tmpdir(), "termx-reconnect-e2e-"));
    runtimePath = path.join(dataDir, "runtime.json");
    host = spawn(HOST_EXE, ["--data-dir", dataDir], {
      stdio: "ignore",
      windowsHide: true,
    });

    await waitFor(
      "runtime.json discovery state",
      () => {
        try {
          const value = readRuntime();
          return (
            typeof value.port === "number"
            && value.port > 0
            && typeof value.token === "string"
            && value.token.length > 0
          );
        } catch {
          return false; // not yet written, or caught mid-write
        }
      },
      20_000,
    );
  }, 60_000);

  afterAll(async () => {
    if (!host) {
      return;
    }
    // Stop retrying BEFORE the host goes away, or teardown races a reconnect.
    try {
      machine?.dispose();
    } catch {
      // already disposed
    }
    try {
      hub?.close();
    } catch {
      // already closed
    }

    let orphaned = false;
    try {
      const parting = await HostClient.connect({
        ...readRuntime(),
        webSocketFactory: (url) => new WebSocket(url),
      });
      parting.shutdown();
    } catch {
      // host may already be down; the pid poll below decides
    }
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
  }, 60_000);

  it("resumes the same session from its byte cursor, with no duplicated output", async () => {
    const established = await connect();
    const states: ConnectionState[] = [];

    machine = ReconnectingHostClient.start<HostClient>({
      initialClient: established,
      connect,
    });
    machine.onStateChange((state) => states.push(state));

    const session = await established.createSession({
      profile: "cmd",
      cwd: null,
      cols: 100,
      rows: 30,
    });

    hub = new AttachmentHub(established);
    const attachments = hub;
    machine.onStateChange((state) => {
      if (state.phase !== "connected") {
        attachments.suspendAll();
      }
    });
    machine.onConnected((client, isReconnect) => {
      if (isReconnect) {
        void attachments.resync(client);
      }
    });

    // The pane's view of the stream: latin1 keeps the byte→char mapping 1:1,
    // so an ASCII marker search survives escape sequences that are not UTF-8.
    let text = "";
    let expectedNextOffset: bigint | null = null;
    const outOfOrder: Array<{ expected: bigint; received: bigint }> = [];
    await attachments.attachSession(session.id);
    await attachments.attach(session.id, {
      onOutput: (event) => {
        if (event.data.byteLength === 0) {
          return;
        }
        if (expectedNextOffset !== null && event.offset !== expectedNextOffset) {
          outOfOrder.push({ expected: expectedNextOffset, received: event.offset });
        }
        expectedNextOffset = event.offset + BigInt(event.data.byteLength);
        text += Buffer.from(event.data).toString("latin1");
      },
    });

    await waitFor("cmd first output", () => text.length > 0);
    expect(attachments.sendInput(session.id, "echo TERMX^_RECONNECT_BEFORE\r")).toBe(true);
    await waitFor(`marker ${FIRST_MARKER}`, () => text.includes(FIRST_MARKER));
    const textBeforeDrop = text;

    // The socket dies underneath a host that keeps running. Nothing is
    // detached, nothing is closed — this is a cable being pulled.
    expect(liveSocket).not.toBeNull();
    liveSocket!.close();

    await waitFor(
      "the machine to notice the drop",
      () => machine!.state.phase !== "connected",
      10_000,
    );
    expect(attachments.getSnapshot().sessions[session.id]?.suspended).toBe(true);

    // Deliberately generous: this connection lived only a few seconds, so the
    // anti-flap floor holds the retry back for most of ANTI_FLAP_FLOOR_MS
    // rather than firing on the 1s first backoff step. Waiting it out here is
    // the end-to-end evidence that the floor is real.
    await waitFor(
      "the machine to reconnect",
      () => machine!.state.phase === "connected",
      ANTI_FLAP_FLOOR_MS + 20_000,
    );
    await waitFor(
      "the hub to re-attach the session",
      () => {
        const snapshot = attachments.getSnapshot().sessions[session.id];
        return snapshot?.suspended === false && snapshot.hostAttached;
      },
      20_000,
    );

    // The session is the SAME shell, still holding its state.
    expect(attachments.sendInput(session.id, "echo TERMX^_RECONNECT_AFTER\r")).toBe(true);
    await waitFor(`marker ${SECOND_MARKER}`, () => text.includes(SECOND_MARKER));

    // The whole point: the resync asked for what it had not seen, so the ring's
    // older bytes were never sent again.
    expect(text.split(FIRST_MARKER).length - 1).toBe(1);
    expect(text.startsWith(textBeforeDrop)).toBe(true);
    expect(outOfOrder).toEqual([]);
    expect(states.map((state) => state.phase)).toContain("connected");
    expect(attachments.getSnapshot().sessions[session.id]?.attachGeneration).toBe(1);
  }, 120_000);
});
