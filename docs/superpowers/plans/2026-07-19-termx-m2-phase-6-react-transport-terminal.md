# TermX M2 Phase 6: React Transport and Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React-owned authenticated protocol-v2 transport, canonical snapshot/event store, reconnect loop, and one-visible-xterm terminal path without allowing renderer lifecycle, replay, queue pressure, or protocol mismatch to terminate or corrupt a live host session.

**Architecture:** React connects directly to the verified loopback WebSocket returned by Phase 5, validates every text frame against closed TypeScript schemas, converts every wire decimal string to `bigint`, and maintains canonical host state only from complete snapshots plus contiguous global events. `HostClient` owns connection/correlation/binary limits; `HostProvider` owns React lifecycle and resnapshot orchestration; `TerminalController` owns exactly one visible xterm instance, ordered replay/live offset reconciliation, input gating, reply suppression, and presentation-only memory trimming.

**Tech Stack:** React `19.2.7`; TypeScript `6.0.3` with `strict`; Vite `8.1.5`; Vitest `4.1.10`; React Testing Library `16.3.2`; Zod `4.4.3` strict runtime schemas; browser WebSocket; `@tauri-apps/api = 2.11.1`; `@xterm/xterm = 6.0.0`; `@xterm/addon-fit = 0.11.0`; `@xterm/addon-webgl = 0.19.0`; ESLint `10.7.0`; jsdom `29.1.1`; fake WebSocket and terminal ports for deterministic tests.

## Global Constraints

- Phases 1-5 exact interfaces and tests must be Fable-approved before this phase begins.
- React directly owns ordinary authenticated WebSocket traffic. Tauri invokes never proxy `Hello`, snapshots, events, attach, replay, binary input/output, resize, layout, safety state, or recovery traffic.
- The renderer receives `websocket_url`, bearer `token`, host/data-directory identity, and version metadata from `bootstrap_host`; it never receives the shutdown-authority key.
- The first React text frame is `Hello`. Protocol major is exactly `2`; enabled features are the intersection defined by `FeatureRegistryV2` at the negotiated minor.
- Every wire `u64` decimal string is validated as canonical unsigned decimal text and decoded to TypeScript `bigint`; bounded session IDs, rows, columns, byte counts, and attempt counts remain `number`.
- Text parsing rejects BOM, invalid JSON, duplicate object keys at any depth, unknown fields, unknown variants, invalid UUIDs, invalid decimal spellings, unsafe JSON integers, and schema/range violations.
- `AuthOk` and `State` raw UTF-8 application JSON are capped at 4 MiB and `Sessions` at 1 MiB. A complete encoded `ReplayChunk` text message is capped at 1 MiB. A complete binary output application frame is capped at 1 MiB including its 13-byte header, so its payload is at most 1,048,563 bytes. Decoded replay data is capped at 512 KiB.
- Pending correlated requests are capped at 1,024 entries and 2 MiB of serialized request bytes. Reaching either cap rejects locally before `WebSocket.send`.
- Mutation acknowledgements settle requests only. Canonical sessions, layout, safety state, revisions, and event cursor mutate only from `AuthOk`/`State` replacement or contiguous `Event` reduction.
- Snapshot installation is atomic. Events at or below its cursor are discarded, exact duplicates are ignored, and a gap, host-instance change, event-buffer overflow, or invalid frame closes the connection and requires a fresh snapshot.
- Renderer reconnect never sends provider launch/resume, continuation, host shutdown, or host restart. UI crash recovery is snapshot plus reattach only.
- A live protocol-major mismatch leaves the host and every session untouched. The renderer enters a terminal compatibility state and invokes no destructive native or WebSocket action automatically.
- One visible terminal controller exists. Switching tabs disposes the prior xterm/addons/listeners, detaches only the old connection attachment, creates one fresh visible xterm, and attaches the selected live session with replay.
- Initial order is zero or more replay chunks, correlated `Attached`, then binary output. Input, paste, and terminal-generated replies remain disabled until replay writes drain and `Attached` has been observed. `replay:true` over an empty interval and `replay:false` both emit zero chunks and use absent wire `Attached.replay_id`; only the domain projection uses `replayId:null`.
- Additional decoded live backlog is capped at exactly 2 MiB; the separately accounted encoded Replay inbox is capped at exactly 16 envelopes and 16 MiB of exact serialized UTF-8 envelope bytes; one decoded Replay item and one decode scratch allocation are each capped at 512 KiB; total controller-owned decoded pending output is capped at 3 MiB. Browser buffering before WebSocket callback delivery is a distinct ownership class.
- Initial replay has protocol priority over its `Attached` and post-attach binary. Active lagged replay instead closes input and schedules by physical `arrivalOrdinal` plus offset eligibility: an earlier live item writes first only after duplicate trimming makes it an exact continuation; an earlier forward-gap live item remains bounded and blocked while later replay fills or visibly advances the missing interval. Lagged replay carries `request_id:null`, receives no second `Attached`, and reopens input only after the final replay callback plus every lower-ordinal retained item has been reconciled or has forced detach.
- xterm visible plus scrollback presentation is capped at 10,000 total lines and an estimated 16 MiB of UTF-16 text, with one 256 KiB measurement interval allowed. History is configured/reconfigured as `max(0, 10_000 - rows)`. Conservative byte-growth accounting triggers measurement before the next write can cross the allowed interval; every 100 writes remains a backstop. Crossing 16 MiB trims oldest presentation data toward 12 MiB and inserts a visible marker; the host ring remains authoritative.
- One logical input line is capped at 256 KiB of decoded host output before a visible hard-wrap/truncation marker. User input and paste are emitted in payload chunks no larger than 240 KiB.
- No production implementation, test, or script hardcodes `C:\Dev\TermX`; runtime paths remain project-relative or native-bootstrap-derived. Absolute paths below identify the plan's files for the implementer.
- Run frontend commands from `C:\Dev\TermX`; use the committed `C:\Dev\TermX\ui\package-lock.json`; treat warnings as failures.
- Do not terminate PID 54876. Do not delete `C:\Dev\TermX\target-review` or `C:\Dev\TermX\target-review-final`. No destructive command is part of this phase.

## Test-Support Contract

Create reusable deterministic test ports instead of putting test-only methods on production classes:

```ts
export interface FakeSocketCloseCall {
  readonly code?: number;
  readonly reason?: string;
}

export class FakeWebSocket implements WebSocketPort {
  readonly url: string;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closeCalls: FakeSocketCloseCall[] = [];
  readyState = SOCKET_CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(url: string);
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  open(): void;
  receiveText(value: unknown): void;
  receiveRawText(value: string): void;
  receiveBinary(value: Uint8Array): void;
  fail(error?: Event): void;
  remoteClose(code?: number, reason?: string): void;
}

export class FakeSocketFactory implements WebSocketFactory {
  readonly sockets: FakeWebSocket[] = [];
  create(url: string): FakeWebSocket;
}

export class FakeTerminalPort implements TerminalPort {
  readonly writes: Array<Uint8Array | string> = [];
  readonly rendererStatuses: TerminalRendererStatus[] = [];
  readonly trimCalls: number[] = [];
  readonly fitCalls: number[] = [];
  focusCallCount = 0;
  constructor(
    readonly options: TerminalFactoryOptions,
    initialMeasurement?: TerminalPresentationMeasurement,
  );
  open(element: HTMLElement): void;
  reset(): void;
  fit(): TerminalDimensions;
  focus(): void;
  write(data: Uint8Array | string, callback: () => void): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onRendererStatus(listener: (status: TerminalRendererStatus) => void): Disposable;
  userData(value: string): void;
  userBinary(value: string): void;
  emitRendererStatus(status: TerminalRendererStatus): void;
  loseWebglContext(): void;
  completeNextWrite(): void;
  pendingWriteCount(): number;
  writtenText(): string;
  isDisposed(): boolean;
  setPresentationMeasurement(
    measurement: TerminalPresentationMeasurement,
  ): void;
  measurePresentation(): TerminalPresentationMeasurement;
  trimPresentationToLines(linesToKeep: number): void;
  dispose(): void;
}

export class FakeTerminalFactory implements TerminalFactory {
  readonly createdOptions: TerminalFactoryOptions[];
  create(options: TerminalFactoryOptions): FakeTerminalPort;
  current(): FakeTerminalPort | null;
  liveCount(): number;
}

export class ManualClock implements HostClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  advanceBy(delayMs: number): void;
}
```

Test-fixture ownership is incremental and exact. Task 1 creates only `FakeWebSocket`, `FakeSocketFactory`, `FakeTerminalPort`, `FakeTerminalFactory`, `ManualClock`, deterministic helpers `bytes(length): Uint8Array`, `bytesFrom(value): Uint8Array`, and `connectionGeneration(value): ConnectionGeneration`, and an otherwise empty `fixtures.ts` export surface; it does not import not-yet-created production modules. Task 2 adds `protocolFixtures`; Task 3 adds the core `HostFixture`; Task 5 extends that same class with provider/native methods; Task 7 adds `TerminalFixture`; Task 8 adds its component-render methods; and Task 9 adds `RendererSafetyFixture`. Each modifying task shows the complete methods it adds, so every intermediate `tsc --noEmit` gate references only production modules that already exist. All helpers live under `C:\Dev\TermX\ui\src\test` and are imported only by tests.

---

### Task 1: Install and lock the frontend test/protocol/terminal toolchain

**Files:**
- Modify: `C:\Dev\TermX\ui\package.json`
- Modify: `C:\Dev\TermX\ui\package-lock.json`
- Modify: `C:\Dev\TermX\ui\tsconfig.json`
- Modify: `C:\Dev\TermX\ui\vite.config.ts`
- Create: `C:\Dev\TermX\ui\vitest.config.ts`
- Create: `C:\Dev\TermX\ui\eslint.config.js`
- Create: `C:\Dev\TermX\ui\src\vite-env.d.ts`
- Create: `C:\Dev\TermX\ui\src\ports.ts`
- Create: `C:\Dev\TermX\ui\src\test\setup.ts`
- Create: `C:\Dev\TermX\ui\src\test\FakeWebSocket.ts`
- Create: `C:\Dev\TermX\ui\src\test\FakeTerminal.ts`
- Create: `C:\Dev\TermX\ui\src\test\fixtures.ts`
- Create: `C:\Dev\TermX\ui\src\test\toolchain.test.ts`

**Interfaces:**
- Consumes: Phase 5 Vite/React scaffold, closed `BootstrapHostResultV1` success-value union, and `NativeInvokeRejectionV1` transport rejection.
- Produces: exact-lock frontend dependencies, strict scripts, jsdom test setup, `WebSocketPort`, `WebSocketFactory`, `TerminalPort`, `TerminalFactory`, `ManualClock`, and primitive deterministic fakes/helpers used by Tasks 2-9. `HostFixture` begins in Task 3 and `TerminalFixture` begins in Task 7, after their production dependencies exist.
- Invariant: tests do not require a real host, browser WebGL implementation, or Tauri runtime unless explicitly deferred to Phase 8 packaged verification.

- [ ] **Step 1: Write the failing toolchain test**

```ts
import { describe, expect, it } from 'vitest';
import { FakeSocketFactory } from './FakeWebSocket';
import { FakeTerminalFactory } from './FakeTerminal';
import type { TerminalFactoryOptions } from '../ports';

 describe('Phase 6 test ports', () => {
  it('creates deterministic sockets and at most one live terminal', () => {
    const sockets = new FakeSocketFactory();
    const terminals = new FakeTerminalFactory();
    const options: TerminalFactoryOptions = {
      rows: 30,
      cols: 120,
      scrollback: 9_970,
    };
    expect(sockets.create('ws://127.0.0.1:40123')).toBe(sockets.sockets[0]);
    const first = terminals.create(options);
    first.dispose();
    const second = terminals.create(options);
    expect(terminals.liveCount()).toBe(1);
    expect(second).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/test/toolchain.test.ts
```

Expected: the `test` script and fake port modules do not exist.

- [ ] **Step 3: Add exact dependencies, scripts, strict compiler/linter settings, and deterministic fakes**

Phase 5 already pins the React/Vite/TypeScript/Tauri scaffold. Verify the implementation runtime first:

```powershell
Set-Location C:\Dev\TermX
node --version
npm --version
```

Expected: exact reviewed toolchain outputs `v24.14.1` and `11.11.0`; any different Node or npm version stops the task until the plan's exact matrix is deliberately re-reviewed. Then install these exact artifacts so `package.json` contains no `^` or `~` ranges and `package-lock.json` pins exact integrity metadata:

```powershell
npm --prefix ui install --save-exact zod@4.4.3 @tauri-apps/api@2.11.1 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-webgl@0.19.0
npm --prefix ui install --save-dev --save-exact vitest@4.1.10 jsdom@29.1.1 @testing-library/react@16.3.2 @testing-library/dom@10.4.1 @testing-library/jest-dom@6.9.1 @testing-library/user-event@14.6.1 eslint@10.7.0 @eslint/js@10.0.1 typescript-eslint@8.64.0 eslint-plugin-react-hooks@7.1.1 eslint-plugin-react-refresh@0.5.3
```

Do not upgrade Phase 5's `typescript = 6.0.3`: `typescript-eslint = 8.64.0` declares `typescript >=4.8.4 <6.1.0`, so `typescript = 7.0.2` is outside the frozen peer range.

Set these scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create all shared production declarations in `C:\Dev\TermX\ui\src\ports.ts` during Task 1. Later tasks import them; they do not redeclare or defer any identifier needed by Task 1's full `tsc --noEmit` gate:

```ts
export interface Disposable {
  dispose(): void;
}

export type TimerHandle = number & {
  readonly __timerHandle: unique symbol;
};

export interface WebSocketPort {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketFactory {
  create(url: string): WebSocketPort;
}

export interface HostClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const SOCKET_CONNECTING = 0 as const;
export const SOCKET_OPEN = 1 as const;
export const SOCKET_CLOSING = 2 as const;
export const SOCKET_CLOSED = 3 as const;

export type TerminalRendererStatus = 'webgl' | 'compatibility';

export interface TerminalDimensions {
  readonly rows: number;
  readonly cols: number;
}

export interface TerminalPresentationMeasurement {
  readonly totalLines: number;
  readonly viewportRows: number;
  readonly estimatedUtf16Bytes: number;
  readonly lineUtf16Bytes: readonly number[];
}

export interface TerminalPort {
  open(element: HTMLElement): void;
  reset(): void;
  fit(): TerminalDimensions;
  focus(): void;
  write(data: Uint8Array | string, callback: () => void): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onRendererStatus(listener: (status: TerminalRendererStatus) => void): Disposable;
  measurePresentation(): TerminalPresentationMeasurement;
  trimPresentationToLines(linesToKeep: number): void;
  dispose(): void;
}

export interface TerminalFactoryOptions {
  readonly rows: number;
  readonly cols: number;
  readonly scrollback: number;
}

export interface TerminalFactory {
  create(options: TerminalFactoryOptions): TerminalPort;
}
```

Use `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `noImplicitOverride` in addition to `strict`. Configure Vitest for jsdom and `src/test/setup.ts`; import `@testing-library/jest-dom/vitest` there.

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/test/toolchain.test.ts
```

Expected: all commands exit 0 with zero warnings; the deterministic fake-port test passes.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/package.json ui/package-lock.json ui/tsconfig.json ui/vite.config.ts ui/vitest.config.ts ui/eslint.config.js ui/src/vite-env.d.ts ui/src/ports.ts ui/src/test
git commit -m "test(ui): lock the React transport harness" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement strict protocol-v2 text and binary codecs

**Files:**
- Create: `C:\Dev\TermX\ui\src\contracts\json.ts`
- Create: `C:\Dev\TermX\ui\src\contracts\shared.ts`
- Create: `C:\Dev\TermX\ui\src\contracts\sharedSchemas.ts`
- Create: `C:\Dev\TermX\ui\src\host\strictJson.ts`
- Create: `C:\Dev\TermX\ui\src\host\protocol.ts`
- Create: `C:\Dev\TermX\ui\src\host\binaryFrames.ts`
- Create: `C:\Dev\TermX\ui\src\host\protocol.test.ts`
- Create: `C:\Dev\TermX\ui\src\host\binaryFrames.test.ts`
- Create: `C:\Dev\TermX\ui\src\host\protocolFixtures.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`
- Consume without modifying: `C:\Dev\TermX\fixtures\canonical\state-v2-fresh.json`
- Consume without modifying: `C:\Dev\TermX\fixtures\canonical\layout-v1.json`
- Consume without modifying: `C:\Dev\TermX\fixtures\canonical\shutdown-preview-v1.json`
- Consume without modifying: `C:\Dev\TermX\fixtures\canonical\recovery-action-preview-v1.json`

**Interfaces:**
- Consumes: exact closed schemas exported by Phase 1 `termx-contracts` and exact request/response/event variants implemented in Phase 2.
- `C:\Dev\TermX\ui\src\contracts\json.ts` is the sole owner of JSON foundations and protocol validation errors:
  ```ts
  export type JsonPrimitive = string | number | boolean | null;
  export type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

  export type ProtocolValidationReason =
    | 'invalid_utf8'
    | 'message_too_large'
    | 'invalid_json'
    | 'duplicate_json_key'
    | 'invalid_schema'
    | 'invalid_feature_negotiation'
    | 'invalid_replay_base64'
    | 'invalid_binary_frame';

  export class ProtocolValidationError extends Error {
    override readonly name = 'ProtocolValidationError';
    constructor(
      readonly reasonCode: ProtocolValidationReason,
      message: string,
    ) {
      super(message);
    }
  }
  ```
- `C:\Dev\TermX\ui\src\contracts\shared.ts` is the sole TypeScript declaration site for every Phase 1 closed layout/config/storage/safety/recovery/native nested contract. It exports exact recursive `snake_case` wire interfaces and branded scalars, including `Timestamp`, `Uuid`, `Sha256Hex`, `Sha256Fingerprint`, `U64DecimalString`, `RequestId`, `ConfigV2`, `ShutdownAuthorizationV1`, `StorageRepairPreviewV1`, `StorageRepairAuthorizationV1`, `StorageRepairExecutionResultV1`, and `StorageRepairStatusV1`. `Uuid` is the one shared brand for every Rust `uuid::Uuid` wire field; semantic meaning comes from the containing closed DTO and no request-only UUID brand or unchecked cast is permitted. `Sha256Hex` is exactly 64 lowercase hexadecimal characters. `Sha256Fingerprint` is a distinct brand whose exact lexical form is `sha256:v1:` followed by 64 lowercase hexadecimal characters. No later task redeclares one of those names.
  ```ts
  import type { z } from 'zod';

  export type Uuid = string & z.$brand<'Uuid'>;
  export type RequestId = Uuid;
  export type Sha256Hex = string & z.$brand<'Sha256Hex'>;
  export type Sha256Fingerprint =
    string & z.$brand<'Sha256Fingerprint'>;
  ```
- `C:\Dev\TermX\ui\src\contracts\sharedSchemas.ts` is the sole runtime-schema site for those declarations. It imports `z` and exports:
  ```ts
  export type StrictSchema<T> = z.ZodType<T>;
  export const timestampSchema: StrictSchema<Timestamp>;
  export const uuidSchema: StrictSchema<Uuid>;
  export const sha256HexSchema: StrictSchema<Sha256Hex>;
  export const sha256FingerprintSchema: StrictSchema<Sha256Fingerprint>;
  export const u64DecimalStringSchema: StrictSchema<U64DecimalString>;
  export const configV2Schema: StrictSchema<ConfigV2>;
  export const shutdownAuthorizationV1Schema:
    StrictSchema<ShutdownAuthorizationV1>;
  export const storageRepairPreviewV1Schema:
    StrictSchema<StorageRepairPreviewV1>;
  export const storageRepairAuthorizationV1Schema:
    StrictSchema<StorageRepairAuthorizationV1>;
  export const storageRepairExecutionResultV1Schema:
    StrictSchema<StorageRepairExecutionResultV1>;
  export const storageRepairStatusV1Schema:
    StrictSchema<StorageRepairStatusV1>;
  ```
  The scalar schemas use these exact lexical validators and Zod brands; callers never cast raw strings:
  ```ts
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
  const SHA256_FINGERPRINT_PATTERN = /^sha256:v1:[0-9a-f]{64}$/;

  export const uuidSchema: StrictSchema<Uuid> =
    z.string().regex(UUID_PATTERN).brand<'Uuid'>();
  export const sha256HexSchema: StrictSchema<Sha256Hex> =
    z.string().regex(SHA256_HEX_PATTERN).brand<'Sha256Hex'>();
  export const sha256FingerprintSchema: StrictSchema<Sha256Fingerprint> =
    z.string().regex(SHA256_FINGERPRINT_PATTERN)
      .brand<'Sha256Fingerprint'>();
  ```
  Every shared result-side Rust `uuid::Uuid` field (`confirmation_id`, `lifecycle_generation`, `repair_id`, `authorization_id`, containment record IDs, and nested authorization identities) is declared as `Uuid` and parsed through `uuidSchema`. Native request/result code and tests use parsed values and contain no casts. Every object schema is `z.strictObject`; every internally tagged union enumerates every approved discriminator and rejects unknown variants. `StorageRepairStatusV1` uses `state: 'prepared'|'authorized'|'in_progress'|'completed'|'cancelled'|'ambiguous'`, and its prepared member includes the correlated `request_id`. Optional fields accept absence only, not explicit null. Decimal schemas in this file preserve canonical wire strings; protocol-domain bigint transforms are defined separately in `protocol.ts`.
- Produces:
  ```ts
  export const PROTOCOL_MAJOR = 2 as const;
  export const CLIENT_PROTOCOL_MINOR = 0 as const;
  export const FEATURE_REGISTRY_V2 = {
    'core.snapshot_events': 0,
    'core.chunked_replay': 0,
    'core.layout_cas': 0,
    'core.safety_state': 0,
    'core.recovery_submit': 0,
  } as const;

  export type KnownFeatureId = keyof typeof FEATURE_REGISTRY_V2;
  export type WireFeatureId = string & { readonly __wireFeatureId: unique symbol };

  export function supportedFeaturesForMinor(minor: number): readonly KnownFeatureId[];
  export function parseWireFeatureId(value: unknown): WireFeatureId;
  export function verifyNegotiatedFeatures(
    negotiatedMinor: number,
    requested: readonly KnownFeatureId[],
    receivedRaw: readonly WireFeatureId[],
  ): readonly KnownFeatureId[];

  // Imported from `../contracts/shared` and re-exported for consumers:
  export type { U64DecimalString, RequestId, Sha256Hex };
  export type HostInstanceId = string & { readonly __hostInstanceId: unique symbol };

  export interface EventCursor {
    readonly hostInstanceId: HostInstanceId;
    readonly eventId: bigint;
  }

  export type ProtocolRequestV2 = HelloRequest | GetStateRequest | ListSessionsRequest |
    AttachRequest | DetachRequest | ResizeRequest | CreateSessionRequest |
    CloseSessionRequest | SetLayoutRequest | GetSafetyStateRequest |
    CommitSafetyStateRequest | StartManagedProviderRequest |
    StartRecoveryProviderRequest | RegisterRecoveryIdentityRequest |
    CreateRecoveryOperationRequest | PrepareRecoveryReviewRequest |
    SubmitRecoveryInputRequest | PrepareTeardownRepairRequest |
    GetTeardownRepairPreparationRequest | RepairTeardownRequest |
    PrepareShutdownRequest | FinalizeShutdownPreparationRequest |
    CancelShutdownPreparationRequest | GetFinalizedShutdownPreparationRequest |
    AuthorizeShutdownRequest | ShutdownRequest;

  export type NativeMacOnlyRequest =
    | GetTeardownRepairPreparationRequest
    | RepairTeardownRequest
    | GetFinalizedShutdownPreparationRequest
    | AuthorizeShutdownRequest;

  // Ordinary React bearer authority excludes native-MAC operations and the
  // final Shutdown transaction. Phase 5 owns native preview retrieval,
  // the OS dialog, and AuthorizeShutdown; React sends final Shutdown only
  // through HostClient's dedicated post-authorization method.
  export type ClientRequest = Exclude<
    ProtocolRequestV2,
    NativeMacOnlyRequest | ShutdownRequest
  >;

  export type AuthorizedShutdownRequest = Extract<
    ProtocolRequestV2,
    ShutdownRequest
  >;

  // Every member is a response/event React may receive on the authenticated
  // WebSocket. Native-only TeardownRepairPreparation, TeardownRepaired,
  // FinalizedShutdownPreparation, and ShutdownAuthorized are absent.
  // ShutdownAccepted remains renderer-visible and settles only the dedicated
  // post-ConfirmShutdown request path.
  export type ServerTextMessage =
    | AuthOkMessage | StateMessage | SessionsMessage | SafetyStateMessage
    | EventMessage | ReplayChunkMessage | AttachedMessage | ServerErrorMessage
    | DetachAcceptedMessage | ResizeAcceptedMessage | SessionCreateAcceptedMessage
    | CloseAcceptedMessage | LayoutSavedMessage | SafetyStateCommittedMessage
    | ManagedProviderAcceptedMessage | RecoveryProviderAcceptedMessage
    | RecoveryIdentityRegisteredMessage | RecoveryOperationCreatedMessage
    | RecoveryReviewPreparedMessage | RecoveryInputAcceptedMessage
    | TeardownRepairPreparedMessage | ShutdownPreparedMessage
    | ShutdownPreparationFinalizedMessage | ShutdownPreparationCancelledMessage
    | ShutdownAcceptedMessage;

  export type ReplayId = string & { readonly __replayId: unique symbol };

  export interface ValidatedReplayBase64 {
    readonly encoded: string;
    readonly decodedByteLength: number;
  }

  export type ParsedServerText =
    | {
        readonly kind: 'event';
        readonly message: EventMessage;
        readonly rawUtf8Bytes: number;
        readonly eventCanonicalKey: Sha256Hex;
      }
    | {
        readonly kind: 'message';
        readonly message: Exclude<ServerTextMessage, EventMessage>;
        readonly rawUtf8Bytes: number;
      };

  export function parseServerTextBytes(raw: Uint8Array): ParsedServerText;
  export function parseServerText(raw: string): ParsedServerText;
  export function encodeClientRequest(request: ClientRequest): string;
  export function encodeAuthorizedShutdownRequest(
    request: AuthorizedShutdownRequest,
  ): string;
  export function canonicalWireEventKey(rawEvent: JsonValue): Sha256Hex;
  export function validateReplayBase64Bounded(
    encoded: unknown,
  ): ValidatedReplayBase64;
  export function decodeReplayBase64Into(
    encoded: ValidatedReplayBase64,
    scratch: Uint8Array,
  ): { readonly bytesWritten: number };
  export function parseU64Decimal(value: unknown, field: string): bigint;
  export function encodeU64Decimal(value: bigint): U64DecimalString;
  export function assertStrictJson(raw: string): void;

  export interface OutputBinaryFrame {
    readonly sessionId: number;
    readonly offset: bigint;
    readonly payload: Uint8Array;
  }

  export function decodeOutputFrame(frame: ArrayBuffer): OutputBinaryFrame;
  export function encodeInputFrame(sessionId: number, payload: Uint8Array): ArrayBuffer;
  ```
- File ownership is exclusive: `protocol.ts` owns text-frame scanning/schema projection and client text encoding; `binaryFrames.ts` alone owns `OutputBinaryFrame`, `decodeOutputFrame`, and `encodeInputFrame`. `protocol.ts` may import/re-export those binary declarations for one public host-contract barrel, but it contains no binary parsing or construction implementation. `TerminalController.ts` alone owns xterm `onBinary` string-to-byte conversion because that conversion is a terminal-adapter concern, not a protocol frame codec.
- Task 2 adds this exact typed fixture surface to `C:\Dev\TermX\ui\src\test\fixtures.ts`:
  ```ts
  export interface SnapshotFixtureOptions {
    readonly eventId: bigint;
    readonly sessionIds?: readonly number[];
  }

  export interface SessionEventFixtureOptions {
    readonly eventId: bigint;
    readonly sessionId: number;
  }

  export interface ProtocolFixtures {
    authOk(options: SnapshotFixtureOptions): AuthOkMessage;
    state(options: SnapshotFixtureOptions): StateMessage;
    sessionCreatedEvent(
      options: SessionEventFixtureOptions,
    ): EventMessage;
    sessionClosedEvent(
      options: SessionEventFixtureOptions,
    ): EventMessage;
  }

  export const protocolFixtures: ProtocolFixtures;
  ```
  Every builder returns a newly deep-frozen valid domain object with deterministic UUIDs and complete required fields; `sessionIds` defaults to an empty frozen array. Task 4 separately adds `eventEnvelope(message: EventMessage): SequencedEventEnvelope` after `SequencedEventEnvelope` exists; it computes the key and UTF-8 byte count through production JCS/codec functions and never invents test-only identity bytes.
- Invariant: `protocol.ts` exports decoded domain objects with `bigint` values; no reducer/controller parses decimal text itself.
- Exact renderer wire table (the quoted names are Rust serde `type` discriminants and fixture assertions must compare them byte-for-byte):

  | Renderer request kind | Success wire `type` | Decoded TypeScript type | Outcome class |
  |---|---|---|---|
  | `GetState` | `State` | `StateMessage` | read-only |
  | `ListSessions` | `Sessions` | `SessionsMessage` | read-only |
  | `GetSafetyState` | `SafetyState` | `SafetyStateMessage` | read-only |
  | `Attach` | `Attached` | `AttachedMessage` | connection mutation |
  | `Detach` | `DetachAccepted` | `DetachAcceptedMessage` | connection mutation |
  | `Resize` | `ResizeAccepted` | `ResizeAcceptedMessage` | mutation |
  | `CreateSession` | `SessionCreateAccepted` | `SessionCreateAcceptedMessage` | mutation |
  | `CloseSession` | `CloseAccepted` | `CloseAcceptedMessage` | mutation |
  | `SetLayout` | `LayoutSaved` | `LayoutSavedMessage` | mutation |
  | `CommitSafetyState` | `SafetyStateCommitted` | `SafetyStateCommittedMessage` | mutation |
  | `StartManagedProvider` | `ManagedProviderAccepted` | `ManagedProviderAcceptedMessage` | mutation |
  | `StartRecoveryProvider` | `RecoveryProviderAccepted` | `RecoveryProviderAcceptedMessage` | mutation |
  | `RegisterRecoveryIdentity` | `RecoveryIdentityRegistered` | `RecoveryIdentityRegisteredMessage` | mutation |
  | `CreateRecoveryOperation` | `RecoveryOperationCreated` | `RecoveryOperationCreatedMessage` | mutation |
  | `PrepareRecoveryReview` | `RecoveryReviewPrepared` | `RecoveryReviewPreparedMessage` | read-only preparation |
  | `SubmitRecoveryInput` | `RecoveryInputAccepted` | `RecoveryInputAcceptedMessage` | mutation |
  | `PrepareTeardownRepair` | `TeardownRepairPrepared` | `TeardownRepairPreparedMessage` | read-only preparation |
  | `PrepareShutdown` | `ShutdownPrepared` | `ShutdownPreparedMessage` | read-only preparation |
  | `FinalizeShutdownPreparation` | `ShutdownPreparationFinalized` | `ShutdownPreparationFinalizedMessage` | read-only finalization |
  | `CancelShutdownPreparation` | `ShutdownPreparationCancelled` | `ShutdownPreparationCancelledMessage` | shutdown transaction |
  | `Shutdown` (dedicated authorized path only) | `ShutdownAccepted` | `ShutdownAcceptedMessage` | shutdown transaction |

  `GetTeardownRepairPreparation -> TeardownRepairPreparation`, `RepairTeardown -> TeardownRepaired`, `GetFinalizedShutdownPreparation -> FinalizedShutdownPreparation`, and `AuthorizeShutdown -> ShutdownAuthorized` remain native-only. They are excluded from `ClientRequest`, `ServerTextMessage`, `RequestResponseMap`, HostClient's generic request method, and renderer subscriptions. Final `Shutdown` is also excluded from ordinary `ClientRequest` and `RequestKind`; after Phase 5 `confirm_shutdown` returns `authorized` and its native connection has received `ShutdownAuthorized`, the dedicated renderer shutdown coordinator sends one `AuthorizedShutdownRequest` and settles it only with renderer-visible `ShutdownAcceptedMessage`.

- [ ] **Step 1: Write failing strict-decoding and binary-boundary tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseServerText } from './protocol';
import { decodeOutputFrame, encodeInputFrame } from './binaryFrames';

 describe('protocol-v2 runtime validation', () => {
  it('decodes canonical decimal strings to bigint', () => {
    const parsed = parseServerText(JSON.stringify({
      type: 'Event',
      host_instance_id: '11111111-1111-4111-8111-111111111111',
      event_id: '9007199254740993',
      event: { type: 'SessionClosed', session_id: 7 },
    }));
    expect(parsed.kind).toBe('event');
    if (parsed.kind === 'event') {
      expect(parsed.message.eventId).toBe(9007199254740993n);
      expect(parsed.eventCanonicalKey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('rejects duplicate keys before JSON.parse can erase them', () => {
    expect(() => parseServerText('{"type":"Event","type":"State"}'))
      .toThrowError(/duplicate object key/i);
  });

  it.each(['01', '-1', '+1', '1.0', ' 1'])('rejects noncanonical u64 %s', value => {
    expect(() => parseServerText(JSON.stringify({
      type: 'Event',
      host_instance_id: '11111111-1111-4111-8111-111111111111',
      event_id: value,
      event: { type: 'SessionClosed', session_id: 7 },
    }))).toThrowError(/unsigned decimal/i);
  });
});

 describe('M1-compatible binary framing', () => {
  it('decodes tag 0x01, little-endian session and u64 offset', () => {
    const bytes = new Uint8Array(13 + 3);
    const view = new DataView(bytes.buffer);
    bytes[0] = 0x01;
    view.setUint32(1, 9, true);
    view.setBigUint64(5, 9007199254740993n, true);
    bytes.set([0x61, 0x62, 0x63], 13);
    expect(decodeOutputFrame(bytes.buffer)).toEqual({
      sessionId: 9,
      offset: 9007199254740993n,
      payload: new Uint8Array([0x61, 0x62, 0x63]),
    });
  });

  it('refuses input beyond the 256 KiB complete-frame cap', () => {
    expect(() => encodeInputFrame(9, new Uint8Array(262_140)))
      .toThrowError(/262139/);
  });
});
```

Add fixtures for malformed UTF-8 bytes; leading UTF-8/U+FEFF BOM; empty input; trailing bytes after one JSON value; missing comma, colon, closing bracket/brace, and value; trailing comma; unterminated string; unescaped control characters; invalid escapes; malformed/lone surrogate escapes and browser-string lone UTF-16 surrogates; duplicate decoded keys at every nesting depth including `"a"` versus `"\\u0061"`; duplicate keys in objects nested inside arrays; unknown top-level/nested fields; invalid UUIDs; `type` first/middle/last; escaped top-level `type`; nested `type` ignored; duplicate top-level `type`; JSON numeric values where decimal strings are required; exact safe-integer boundaries and unsafe numeric literals before `JSON.parse`; valid/malformed exponent forms; wrong protocol variants; exact and plus-one raw UTF-8 application-byte boundaries for `AuthOk`/`State` at 4,194,304 and `Sessions`/complete encoded `ReplayChunk` at 1,048,576; canonical replay base64 alphabet/padding/trailing-bit validation and decoded 524,288/524,289-byte boundaries; wrong binary tags; binary frames shorter than 13 bytes; and complete output-frame 1,048,576/1,048,577-byte boundaries including the 13-byte header.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/host/protocol.test.ts src/host/binaryFrames.test.ts src/host/protocolFixtures.test.ts
```

Expected: codec modules and closed runtime schemas do not exist.

- [ ] **Step 3: Implement strict JSON scanning, closed Zod schemas, bigint transforms, and exact binary framing**

`strictJson.ts` exposes byte and already-decoded browser-string entry points with this mandatory sequence: (1) `parseServerTextBytes(raw: Uint8Array)` checks `raw.byteLength > 4_194_304` as its first operation, before decoding, copying, type scanning, or `JSON.parse`; `parseServerText(raw: string)` instead performs one allocation-free UTF-16-scalar/UTF-8-byte-count pass that rejects a leading U+FEFF, lone/unpaired surrogates, and more than 4,194,304 UTF-8 bytes before any encoded copy; (2) the byte path uses `TextDecoder('utf-8', { fatal: true })`, rejects a decoded leading U+FEFF, and applies the same scalar validation; (3) one complete lexical scanner validates the whole JSON value and discovers the depth-one `type`; (4) the recovered discriminant selects the exact whole-message application-byte cap; (5) the implementation calls `JSON.parse` exactly once; (6) one closed strict Zod schema validates and projects the message. No type scan occurs before the global cap.

The complete scanner validates string, escape, control-character, surrogate-escape, number, object/array delimiter, comma/colon, EOF, and trailing-byte grammar independently of `JSON.parse`. It maintains object-local sets of decoded key text at every depth, so literal and escaped-equivalent keys collide. It records every numeric lexeme before ordinary parsing. Each lexeme must have valid JSON number grammar and an exact finite mathematical value representable by its target closed schema; integer/range fields are evaluated with string/`BigInt` arithmetic before `JSON.parse`, never `Number(lexeme)`, so unsafe integers and out-of-range values are rejected before rounding can occur. Fields specified as decimal strings are rejected by the closed schema when encoded as JSON numbers. The scanner accepts `type` in any property position, uses only one top-level depth-one string key named exactly `type`, ignores nested `type` for discriminant selection, rejects duplicate decoded `type`, and still finishes validating the complete object. Unknown, missing, or non-string top-level discriminants are `invalid_frame`. Do not use a reviver or a duplicate-only parser.

Whole-message caps count raw UTF-8 application JSON bytes and are inclusive: `AuthOk` and `State` accept at most 4,194,304; `Sessions` and complete encoded `ReplayChunk` accept at most 1,048,576; one additional application byte rejects. Decoded replay data accepts at most 524,288 bytes. `validateReplayBase64Bounded` rejects an encoded value longer than `4 * Math.ceil(524_288 / 3)`, whitespace, non-alphabet characters, invalid/noncanonical padding, and nonzero trailing bits; it computes the exact decoded length without allocating decoded bytes and returns the original canonical string only inside `ValidatedReplayBase64`. The closed Replay schema retains that validated object plus its `decodedByteLength`; no second encoded copy is created. `decodeReplayBase64Into` is the sole materializing decoder: it requires a caller-owned scratch of exactly 524,288 bytes, writes quartets directly into that scratch without `atob`, a binary string, or a second allocation, verifies that the bytes written equal `decodedByteLength`, and returns only `{ bytesWritten }`; the controller takes `scratch.subarray(0, bytesWritten)` and makes the single queue-owned copy before scratch reuse. The text parser never materializes replay bytes. The output binary-frame cap remains 1,048,576 including its 13-byte header, for a 1,048,563-byte maximum payload.

`canonicalWireEventKey` consumes the validated exact snake_case wire `Event` object before camelCase/`bigint` projection, encodes RFC 8785/JCS with property ordering by UTF-16 code units and canonical escaping/number rules, hashes those UTF-8 bytes with SHA-256, and returns lowercase branded `Sha256Hex`. It never hashes the decoded domain object, uses insertion-order `JSON.stringify`, or uses locale-dependent comparison. Reordered wire keys with identical values produce one key; a JSON number and decimal string remain distinct.

Use one canonical decimal schema everywhere:

```ts
const U64_MAX = 18_446_744_073_709_551_615n;

export const u64DecimalSchema = z.string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expected canonical unsigned decimal string')
  .transform((value, context) => {
    const decoded = BigInt(value);
    if (decoded > U64_MAX) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'u64 overflow' });
      return z.NEVER;
    }
    return decoded;
  });
```

Define strict schemas and decoded interfaces for every renderer-visible Phase 2 request, response, error-detail, event, snapshot, layout, safety, recovery, shutdown, repair-status, containment-status, profile, and session variant. Shared fixture schemas also cover native-only variants, but they are not exported through HostClient. Discriminants are the exact Rust serde names frozen by Phase 1/2 and asserted through the wire table above. `parseServerTextBytes`/`parseServerText` apply the scanner and message cap rules above, then return decoded camel-case domain objects. `encodeClientRequest` validates the renderer subset, converts `bigint` fields through `encodeU64Decimal`, and serializes one closed snake-case wire object. It rejects native-only discriminants even when a caller bypasses TypeScript with `unknown`.

Implement binary input with a new owned buffer and no caller-view aliasing:

```ts
export function encodeInputFrame(sessionId: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffff_ffff) {
    throw new ProtocolValidationError(
      'invalid_binary_frame',
      'session_id is outside u32',
    );
  }
  if (payload.byteLength > 262_139) {
    throw new ProtocolValidationError(
      'invalid_binary_frame',
      'input payload exceeds 262139 bytes',
    );
  }
  const frame = new ArrayBuffer(5 + payload.byteLength);
  const bytes = new Uint8Array(frame);
  const view = new DataView(frame);
  bytes[0] = 0x02;
  view.setUint32(1, sessionId, true);
  bytes.set(payload, 5);
  return frame;
}
```

- [ ] **Step 4: Verify GREEN and Rust/TypeScript fixture parity**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/host/protocol.test.ts src/host/binaryFrames.test.ts src/host/protocolFixtures.test.ts
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-contracts --test schema_validation
```

Expected: TypeScript codec tests and Rust contract fixtures pass; exact shared fixtures are accepted/rejected identically.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/host/strictJson.ts ui/src/host/protocol.ts ui/src/host/binaryFrames.ts ui/src/host/protocol.test.ts ui/src/host/binaryFrames.test.ts ui/src/host/protocolFixtures.test.ts ui/src/test/fixtures.ts
git commit -m "feat(ui): validate protocol v2 frames" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Implement bounded HostClient handshake, correlation, and binary dispatch

**Files:**
- Create: `C:\Dev\TermX\ui\src\native\bootstrapContracts.ts`
- Create: `C:\Dev\TermX\ui\src\host\HostClient.ts`
- Create: `C:\Dev\TermX\ui\src\host\HostClient.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\FakeWebSocket.ts`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`

**Interfaces:**
- Consumes: the `ready.bootstrap` member of Phase 5 `BootstrapHostResultV1`, `WebSocketFactory`, `HostClock`, and Task 2 codecs.
- Ownership: Task 3 creates `C:\Dev\TermX\ui\src\native\bootstrapContracts.ts` as the sole declaration/runtime-schema site for `RendererHostBootstrapV1` and `rendererHostBootstrapV1Schema`. `HostClient.ts` and Task 5 `nativeContracts.ts` import and re-export those names; neither redeclares them.
- Produces:
  ```ts
  // Exact TypeScript validator/projection of the Phase 5 native wire DTO.
  // Native-boundary fields remain recursively snake_case; do not create an
  // implicit camelCase alias passed directly to HostClient.
  export interface RendererHostBootstrapV1 {
    readonly websocket_url: string;
    readonly token: string;
    readonly data_dir_instance_id: string;
    readonly host_instance_id: string;
    readonly host_version: string;
    readonly protocol_major: number;
    readonly protocol_minor: number;
  }

  export type ConnectionGeneration = number & {
    readonly __connectionGeneration: unique symbol;
  };

  export interface HostClientOptions {
    readonly clientVersion: string;
    readonly socketFactory: WebSocketFactory;
    readonly clock: HostClock;
    readonly requestIds: RequestIdSource;
    readonly connectionGeneration: ConnectionGeneration;
  }

  export type HostClientState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'connecting'; readonly attempt: number }
    | { readonly kind: 'authenticating' }
    | { readonly kind: 'ready'; readonly hostInstanceId: HostInstanceId }
    | { readonly kind: 'disconnected'; readonly reason: HostDisconnectReason }
    | { readonly kind: 'protocol_mismatch'; readonly mismatch: ProtocolMismatch };

  export interface GenerationTaggedHostClientState {
    readonly connectionGeneration: ConnectionGeneration;
    readonly state: HostClientState;
  }

  export interface RequestIdSource {
    next(): RequestId;
  }

  export type HostDisconnectReason =
    | 'renderer_dispose'
    | 'remote_close'
    | 'socket_error'
    | 'invalid_frame'
    | 'request_table_overflow'
    | 'event_gap'
    | 'event_buffer_overflow'
    | 'host_instance_changed'
    | 'resnapshot';

  export interface ProtocolMismatch {
    readonly uiVersion: string;
    readonly hostVersion: string;
    readonly uiProtocolMajor: 2;
    readonly hostProtocolMajor: number;
  }

  export interface RequestOptions {
    readonly timeoutMs?: number;
  }

  export interface RequestResponseMap {
    readonly GetState: StateMessage;
    readonly ListSessions: SessionsMessage;
    readonly Attach: AttachedMessage;
    readonly Detach: DetachAcceptedMessage;
    readonly Resize: ResizeAcceptedMessage;
    readonly CreateSession: SessionCreateAcceptedMessage;
    readonly CloseSession: CloseAcceptedMessage;
    readonly SetLayout: LayoutSavedMessage;
    readonly GetSafetyState: SafetyStateMessage;
    readonly CommitSafetyState: SafetyStateCommittedMessage;
    readonly StartManagedProvider: ManagedProviderAcceptedMessage;
    readonly StartRecoveryProvider: RecoveryProviderAcceptedMessage;
    readonly RegisterRecoveryIdentity: RecoveryIdentityRegisteredMessage;
    readonly CreateRecoveryOperation: RecoveryOperationCreatedMessage;
    readonly PrepareRecoveryReview: RecoveryReviewPreparedMessage;
    readonly SubmitRecoveryInput: RecoveryInputAcceptedMessage;
    readonly PrepareTeardownRepair: TeardownRepairPreparedMessage;
    readonly PrepareShutdown: ShutdownPreparedMessage;
    readonly FinalizeShutdownPreparation: ShutdownPreparationFinalizedMessage;
    readonly CancelShutdownPreparation: ShutdownPreparationCancelledMessage;
  }

  export type RequestKind = keyof RequestResponseMap;
  export type RequestOf<K extends RequestKind> = Extract<ClientRequest, { readonly type: K }>;
  export type RequestPayloadOf<K extends RequestKind> = Omit<RequestOf<K>, 'requestId'>;

  export type RequestEffect =
    | 'read_only'
    | 'attachment'
    | 'durable_mutation'
    | 'shutdown_transaction';

  export type TombstoneIdentityValue = string | number;
  export type TombstoneValidationIdentity = Readonly<
    Record<string, TombstoneIdentityValue>
  >;

  export interface ResponseValidator<
    TRequest,
    TResponse extends ServerTextMessage,
  > {
    readonly validateResponse: (
      request: TRequest,
      response: TResponse,
    ) => void;
    readonly validateErrorResponse: (
      request: TRequest,
      response: ServerErrorMessage,
    ) => void;
    readonly projectTombstoneIdentity: (
      request: TRequest,
    ) => TombstoneValidationIdentity;
    readonly validateLateSuccess: (
      identity: TombstoneValidationIdentity,
      response: TResponse,
    ) => void;
    readonly validateLateError: (
      identity: TombstoneValidationIdentity,
      response: ServerErrorMessage,
    ) => void;
  }

  export interface RequestKindMetadata<K extends RequestKind>
    extends ResponseValidator<RequestOf<K>, RequestResponseMap[K]> {
    readonly responseTypes: readonly RequestResponseMap[K]['type'][];
    readonly effect: RequestEffect;
    readonly defaultTimeoutMs: number;
    readonly reconciliation:
      | 'discard'
      | 'detach_then_reattach'
      | 'get_state'
      | 'shutdown_coordinator';
  }

  export const READ_REQUEST_TIMEOUT_MS = 15_000 as const;
  export const ATTACHMENT_REQUEST_TIMEOUT_MS = 15_000 as const;
  export const MUTATION_REQUEST_TIMEOUT_MS = 30_000 as const;
  export const PREPARATION_REQUEST_TIMEOUT_MS = 30_000 as const;
  export const SHUTDOWN_TRANSACTION_TIMEOUT_MS = 30_000 as const;

  export const REQUEST_KIND_METADATA = {
    GetState: requestMetadata(
      ['State'], 'read_only', READ_REQUEST_TIMEOUT_MS, 'discard',
      validateNoEchoedIdentity,
    ),
    ListSessions: requestMetadata(
      ['Sessions'], 'read_only', READ_REQUEST_TIMEOUT_MS, 'discard',
      validateNoEchoedIdentity,
    ),
    Attach: requestMetadata(
      ['Attached'], 'attachment', ATTACHMENT_REQUEST_TIMEOUT_MS,
      'detach_then_reattach', validateSessionId,
    ),
    Detach: requestMetadata(
      ['DetachAccepted'], 'attachment', ATTACHMENT_REQUEST_TIMEOUT_MS,
      'detach_then_reattach', validateSessionId,
    ),
    Resize: requestMetadata(
      ['ResizeAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateSessionId,
    ),
    CreateSession: requestMetadata(
      ['SessionCreateAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateCreatedSession,
    ),
    CloseSession: requestMetadata(
      ['CloseAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateSessionId,
    ),
    SetLayout: requestMetadata(
      ['LayoutSaved'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateNextLayoutRevision,
    ),
    GetSafetyState: requestMetadata(
      ['SafetyState'], 'read_only', READ_REQUEST_TIMEOUT_MS, 'discard',
      validateNoEchoedIdentity,
    ),
    CommitSafetyState: requestMetadata(
      ['SafetyStateCommitted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateNextSafetyRevision,
    ),
    StartManagedProvider: requestMetadata(
      ['ManagedProviderAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateManagedProviderIdentity,
    ),
    StartRecoveryProvider: requestMetadata(
      ['RecoveryProviderAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateRecoveryProviderIdentity,
    ),
    RegisterRecoveryIdentity: requestMetadata(
      ['RecoveryIdentityRegistered'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateRegisteredRecoveryIdentity,
    ),
    CreateRecoveryOperation: requestMetadata(
      ['RecoveryOperationCreated'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateCreatedRecoveryOperation,
    ),
    PrepareRecoveryReview: requestMetadata(
      ['RecoveryReviewPrepared'], 'read_only', PREPARATION_REQUEST_TIMEOUT_MS,
      'discard', validateRecoveryReviewPreparation,
    ),
    SubmitRecoveryInput: requestMetadata(
      ['RecoveryInputAccepted'], 'durable_mutation', MUTATION_REQUEST_TIMEOUT_MS,
      'get_state', validateRecoverySubmissionIdentity,
    ),
    PrepareTeardownRepair: requestMetadata(
      ['TeardownRepairPrepared'], 'read_only', PREPARATION_REQUEST_TIMEOUT_MS,
      'discard', validateTeardownPreparation,
    ),
    PrepareShutdown: requestMetadata(
      ['ShutdownPrepared'], 'read_only', PREPARATION_REQUEST_TIMEOUT_MS,
      'discard', validateShutdownPreparation,
    ),
    FinalizeShutdownPreparation: requestMetadata(
      ['ShutdownPreparationFinalized'], 'read_only', PREPARATION_REQUEST_TIMEOUT_MS,
      'discard', validateFinalizedShutdownPreparation,
    ),
    CancelShutdownPreparation: requestMetadata(
      ['ShutdownPreparationCancelled'], 'shutdown_transaction',
      SHUTDOWN_TRANSACTION_TIMEOUT_MS, 'shutdown_coordinator',
      validateCancelledShutdownPreparation,
    ),
  } as const satisfies {
    readonly [K in RequestKind]: RequestKindMetadata<K>;
  };
  ```

  `requestMetadata` is a generic identity helper that preserves the concrete request/response pair and adds no runtime fallback. Its final argument is the named `ResponseValidator<RequestOf<K>, RequestResponseMap[K]>` object shown in each row. Every validator object is defined in Task 3 and owns five operations: validate the live success, validate the live structured error, project the minimum immutable request identity needed after timeout, validate a late success against that projection, and validate a late structured error against that projection. The late functions are module-level functions and receive the frozen projection explicitly; they must not close over or retain the complete request.

  The identity rules are exact:

  - `validateNoEchoedIdentity` projects `Object.freeze({})` and validates no identity beyond the already-correlated `request_id` because the success schema carries none. Its error validator still applies the common structured-error rules below.
  - `validateSessionId` projects `{ session_id: request.sessionId }` and requires a success or error `session_id`, when that field is present, to equal it. A success type whose schema requires `session_id` must contain it.
  - `validateCreatedSession` projects `Object.freeze({})` and requires `response.info.sessionId === response.sessionId`; creation has no caller-selected session ID. A correlated error with `session_id` is invalid because no caller-selected session identity exists.
  - `validateNextLayoutRevision` and `validateNextSafetyRevision` project `{ expected_revision: encodeU64Decimal(request.expectedRevision) }` and require the success revision to equal `request.expectedRevision + 1n`; `layout_conflict` and `safety_state_conflict` errors respectively require the matching closed details variant and may report the authoritative revision rather than the expected revision.
  - `validateManagedProviderIdentity` projects the caller-supplied stable-tab and launch/admission identities that the exact success or `RecoveryErrorDetails` schema can echo. It compares each echoed caller-supplied identity; host-generated `sessionId`/`launchAttemptId` are validated by the strict schema but are not compared with nonexistent request fields.
  - `validateRecoveryProviderIdentity`, `validateRegisteredRecoveryIdentity`, `validateCreatedRecoveryOperation`, `validateRecoveryReviewPreparation`, `validateRecoverySubmissionIdentity`, `validateTeardownPreparation`, `validateShutdownPreparation`, `validateFinalizedShutdownPreparation`, and `validateCancelledShutdownPreparation` project and compare every operation, record, submission, preparation, confirmation, and attempt identity present in both exact request and response/error schemas. They compare a fingerprint only when that exact response/error schema echoes that fingerprint.

  The common structured-error validator requires the matching `request_id`; rejects an error `session_id` when the validator has no projected session identity; compares `session_id` when one was projected; and, for `RecoveryErrorDetails`, compares every optional identity that is both present in `details` and present in the validator's projection. Conflict detail variants are legal only for their matching request kind and error code. `SizeLimitDetails` carries no request identity. A pending validated structured error rejects the original Promise with `new HostError(message)`; it is not checked against the success `responseTypes` list. A validated late structured error for an unexpired tombstone is retained only as bounded diagnostics and otherwise ignored because the caller already received a timeout outcome. Any live or late validator mismatch throws `ProtocolValidationError`; HostClient closes the generation with `invalid_frame`, releases any pending reservation exactly once, and never mutates canonical state from that frame.

  ```ts
  export interface HostClientMetrics {
    readonly pendingRequestCount: number;
    readonly pendingRequestBytes: number;
    readonly invalidFrameCount: number;
  }

  export type HostStreamItem =
    | {
        readonly kind: 'replay';
        readonly connectionGeneration: ConnectionGeneration;
        readonly arrivalOrdinal: bigint;
        readonly rawUtf8Bytes: number;
        readonly message: ReplayChunkMessage;
      }
    | {
        readonly kind: 'attached';
        readonly connectionGeneration: ConnectionGeneration;
        readonly arrivalOrdinal: bigint;
        readonly rawUtf8Bytes: number;
        readonly message: AttachedMessage;
      }
    | {
        readonly kind: 'output';
        readonly connectionGeneration: ConnectionGeneration;
        readonly arrivalOrdinal: bigint;
        readonly frame: OutputBinaryFrame;
      };

  export type HostTextEnvelope =
    | {
        readonly kind: 'event';
        readonly connectionGeneration: ConnectionGeneration;
        readonly arrivalOrdinal: bigint;
        readonly rawUtf8Bytes: number;
        readonly canonicalKey: Sha256Hex;
        readonly message: EventMessage;
      }
    | {
        readonly kind: 'message';
        readonly connectionGeneration: ConnectionGeneration;
        readonly arrivalOrdinal: bigint;
        readonly rawUtf8Bytes: number;
        readonly message: Exclude<
          ServerTextMessage,
          EventMessage | ReplayChunkMessage | AttachedMessage
        >;
      };

  export interface TrackedRequest<T> {
    readonly requestId: RequestId;
    readonly response: Promise<T>;
  }

  export type AuthorizedShutdownPayload = Omit<
    AuthorizedShutdownRequest,
    'requestId'
  >;

  export class HostClient {
    constructor(options: HostClientOptions);
    connect(bootstrap: RendererHostBootstrapV1): Promise<AuthOkMessage>;
    requestTracked<K extends RequestKind>(
      request: RequestPayloadOf<K>,
      options?: RequestOptions,
    ): TrackedRequest<RequestResponseMap[K]>;
    request<K extends RequestKind>(
      request: RequestPayloadOf<K>,
      options?: RequestOptions,
    ): Promise<RequestResponseMap[K]>;
    sendAuthorizedShutdown(
      request: AuthorizedShutdownPayload,
      options?: RequestOptions,
    ): TrackedRequest<ShutdownAcceptedMessage>;
    reconcileUnknownDurableMutation(
      error: MutationOutcomeUnknownError & {
        readonly effect: 'durable_mutation';
        readonly reconciliation: 'get_state';
      },
    ): Promise<StateMessage>;
    connectionGeneration(): ConnectionGeneration;
    sendInput(sessionId: number, payload: Uint8Array): void;
    subscribeText(listener: (envelope: HostTextEnvelope) => void): Disposable;
    subscribeStream(listener: (item: HostStreamItem) => void): Disposable;
    subscribeState(
      listener: (state: GenerationTaggedHostClientState) => void,
    ): Disposable;
    metrics(): HostClientMetrics;
    disconnect(reason: HostDisconnectReason): void;
  }
  ```
- `HostFixture` is introduced in Task 3 with this core contract: public readonly `socketFactory`, `socket`, `clock`, `requestIds`, `connectionGeneration`, `bootstrap`, and `client`; static `ready(): Promise<HostFixture>`; and methods `sentTypes`, `sentHello`, `replyAuthOk`, `fillPendingRequests`, `getStateRequest`, `resizeRequest`, `lastSentRequestId`, and `countSentRequest`. It constructs the client with exact `HostClientOptions`, opens/authenticates only when the test requests it, decodes sent text through the real strict protocol codec, and never calls private production methods. Task 5 extends the same class with provider/native fields and methods rather than creating a second incompatible fixture.
- Invariant: `Attach` settles only on correlated `Attached`; replay chunks are streamed to subscribers and never retained in the completed request result. `HostClient` owns socket closure, pending-request rejection, and generation-tagged violation/disconnect notification only. `HostProvider` is the sole owner of reconnect/resnapshot scheduling, and `TerminalController` is the sole owner of attachment resynchronization.

- [ ] **Step 1: Write failing handshake/correlation/cap tests**

```ts
import { describe, expect, it } from 'vitest';
import { HostFixture } from '../test/fixtures';

 describe('HostClient', () => {
  it('sends Hello first and resolves only the matching AuthOk', async () => {
    const fixture = new HostFixture();
    const connecting = fixture.client.connect(fixture.bootstrap);
    fixture.socket.open();
    expect(fixture.sentTypes()).toEqual(['Hello']);
    expect(fixture.sentHello()).toMatchObject({
      protocol_major: 2,
      protocol_minor: 0,
      supported_features: [
        'core.snapshot_events',
        'core.chunked_replay',
        'core.layout_cas',
        'core.safety_state',
        'core.recovery_submit',
      ],
      token: fixture.bootstrap.token,
    });
    fixture.replyAuthOk();
    await expect(connecting).resolves.toMatchObject({ type: 'AuthOk' });
  });

  it('rejects the 1025th pending request before sending it', async () => {
    const fixture = await HostFixture.ready();
    fixture.fillPendingRequests(1_024);
    const sentBefore = fixture.socket.sent.length;
    await expect(fixture.client.request(fixture.getStateRequest(), {
      timeoutMs: 15_000,
    })).rejects.toThrowError(/1024/);
    expect(fixture.socket.sent).toHaveLength(sentBefore);
  });

  it('classifies a timed-out mutation as unknown and does not resend', async () => {
    const fixture = await HostFixture.ready();
    const pending = fixture.client.request(fixture.resizeRequest(80, 24), {
      timeoutMs: 1_000,
    });
    const requestId = fixture.lastSentRequestId('Resize');
    fixture.clock.advanceBy(1_000);
    await expect(pending).rejects.toMatchObject({ name: 'MutationOutcomeUnknownError' });
    expect(fixture.countSentRequest(requestId)).toBe(1);
  });
});
```

Add tests for 2 MiB pending-byte rejection, HostClient-generated request IDs, a `RequestIdSource` duplicate/capacity failure before send, whole-connection non-reuse after settlement/tombstone expiry, out-of-order responses, wrong-kind same-ID response disconnect, same-kind/same-ID response with a wrong echoed session/operation/preparation identity disconnect, structured error rejection with the original `HostError`, generated `Hello.request_id`, feature intersection at negotiated minor, syntactically valid unknown feature ignored, malformed feature rejected, duplicate raw feature rejected, missing/extra known enabled feature rejected, bootstrap/AuthOk host and data-directory identity equality, `negotiated_minor=min(client,host)`, `ReplayChunk` delivery without request settlement, `Attached` settlement, binary output dispatch at exactly 1 MiB and rejection at 1 MiB plus one byte, malformed frame disconnect, send while not ready, input frame cap, listener disposal, request rejection on disconnect, generation tagging, and metrics returning to zero after settlement. Add a compile-time `@ts-expect-error` assertion that `client.request({ type: 'Shutdown', ... })` is not callable, plus runtime tests that `sendAuthorizedShutdown` generates its own request ID, sends exactly one encoded `Shutdown`, reserves pending count/bytes under internal `shutdown_transaction` metadata, settles only on the matching `ShutdownAccepted`, disconnects on a same-ID response of any other kind, and on timeout returns `MutationOutcomeUnknownError` with immutable `effect='shutdown_transaction'` and reconciliation `shutdown_coordinator` without retrying. Timeout tests must prove: (a) a late success matching an unexpired tombstone is validated by allowed type plus request-specific echoed identities and then ignored rather than treated as an unknown ID; (b) a late structured `Error` matching the same tombstone is validated independently of the success-type list and ignored; (c) a late success of the wrong wire type or wrong echoed identity, and a late error with a mismatched `session_id` or recovery-detail identity, are protocol violations; (d) tombstones retain only the frozen projected identity and module-level validators, not the complete request or Promise closures; (e) `utf8Bytes` equals the canonical metadata including `validation_identity`; (f) mutation timeout disconnects the current generation so HostProvider resnapshots; (g) read-only tombstone count/bytes are bounded; and (h) the connection closes at tombstone expiry, so no response can become unknown after tombstone deletion. The request fingerprint is tombstone diagnostic/idempotency metadata only because responses do not echo it.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/host/HostClient.test.ts
```

Expected: `HostClient` and request accounting do not exist.

- [ ] **Step 3: Implement one socket owner and bounded pending table**

HostClient, not callers, generates every request ID. It owns one `Set<RequestId>` for the complete connection lifetime and never removes an ID after settlement; a repeated ID from `RequestIdSource` is skipped, and inability to produce a fresh ID before the 65,536-ID connection cap closes the socket before send. This makes reuse impossible after cache/tombstone eviction. Connection generation is not socket-local: `HostProvider` starts at branded generation 1, increments before constructing every replacement `HostClient`, passes it through `HostClientOptions`, and never resets it when reconnecting to the same host. Every callback compares that generation before parsing or delivery; state notifications, text envelopes, stream items, and disconnect observations all carry it.

Use a heterogeneous `Map<RequestId, PendingRequest<PendingRequestKind>>`, where `PendingRequestKind = RequestKind | 'Shutdown'`. Ordinary insertion comes only through a generic helper that binds the concrete `K`, `RequestPayloadOf<K>`, and literal `REQUEST_KIND_METADATA[K]` before erasure into the map. The table contains one explicit row per request kind; each row supplies the exact success discriminant, effect, reconciliation, timeout, and request-specific semantic response validator. `GetState|ListSessions|GetSafetyState` use read-only/discard/15,000 ms; `Attach|Detach` use attachment/detach-then-reattach/15,000 ms; ordinary durable mutations use get-state/30,000 ms; the four read-only preparation/finalization requests use discard/30,000 ms; `CancelShutdownPreparation` uses shutdown-coordinator/30,000 ms. Validators compare every echoed session, stable-tab, operation, attempt, submission, creation, preparation, or confirmation identity present in the exact response schema; a same-ID/same-type response with a mismatch is `invalid_frame`. `sendAuthorizedShutdown` is the only other insertion path: it generates the request ID internally, encodes `AuthorizedShutdownRequest`, and supplies private immutable metadata `{ responseTypes: ['ShutdownAccepted'], effect: 'shutdown_transaction', reconciliation: 'shutdown_coordinator', defaultTimeoutMs: 30_000, ...shutdownResponseValidator }`, where `shutdownResponseValidator` satisfies `ResponseValidator<AuthorizedShutdownRequest, ShutdownAcceptedMessage>` and projects every shutdown preparation/confirmation identity shared by the exact request and success/error schemas. `Shutdown` is absent from `RequestResponseMap`, `RequestKind`, `REQUEST_KIND_METADATA`, `requestTracked`, and `request`; callers cannot route it through the generic request API or select its effect/response metadata. Each entry stores the complete original validated request required for semantic response checking, request fingerprint, serialized byte length, exact allowed response discriminants, timeout handle, and type-safe resolve/reject closures. Reserve count/bytes before `send`; on every response, timeout, send exception, or disconnect, remove the entry and release its exact byte reservation once.

On timeout, call the pending entry's `projectTombstoneIdentity()` while the complete validated request still exists, deep-freeze that compact projection, and move the request ID/kind/fingerprint/effect/reconciliation/allowed-success-types/projection plus the two module-level late validators into the tombstone ledger before rejecting. The tombstone never retains the complete request, Promise closures, resolver, rejecter, timeout handle, or serialized request bytes. `read_only` rejects with `RequestTimeoutError` and reconciliation `discard`; the socket may remain open while the tombstone stays live. `attachment` rejects with `MutationOutcomeUnknownError`, closes the current generation with `resnapshot`, and requires the controller's fresh-generation `Detach`/new-`Attach` path rather than retrying the timed-out ID. `durable_mutation` rejects with `MutationOutcomeUnknownError`, closes the current generation with `resnapshot`, and permits only a fresh post-reconnect `GetState` comparison. `shutdown_transaction` rejects with `MutationOutcomeUnknownError`, closes the current generation, and delegates reconciliation to the Phase 7 shutdown coordinator; HostClient never retries or decides shutdown outcome.

A correlated non-`Error` frame for an unexpired tombstone must have an allowed success type and pass `validateLateSuccess(validationIdentity, message)`. A correlated `Error` frame bypasses the success-type list and must pass `validateLateError(validationIdentity, message)`. Either valid late frame is counted in bounded diagnostics and ignored for Promise settlement and canonical mutation. A wrong success wire type, wrong echoed identity, malformed error detail/identity, or truly unknown request ID is a protocol violation. The request fingerprint is not compared with a response because protocol responses do not echo it. If a tombstone reaches 60 seconds, or an insertion would exceed 1,024 entries/256 KiB, close the socket before deleting or forgetting any ID. Tombstone logical bytes are the exact UTF-8 bytes of canonical compact JSON containing `request_id`, `request_kind`, `request_fingerprint`, `effect`, `reconciliation`, sorted `response_types`, and `validation_identity` with lexicographically sorted keys and decimal values represented as canonical strings. Function references and JS object/Map overhead are excluded from logical bytes, while item count remains independently bounded.

```ts
type PendingRequestKind = RequestKind | 'Shutdown';

interface ErasedPendingRequest {
  readonly requestId: RequestId;
  readonly requestKind: PendingRequestKind;
  readonly requestFingerprint: Sha256Hex;
  readonly serializedBytes: number;
  readonly responseTypes: readonly ServerTextMessage['type'][];
  readonly effect: RequestEffect;
  readonly reconciliation: RequestKindMetadata<RequestKind>['reconciliation'];
  readonly timeout: TimerHandle;
  readonly resolveValidatedSuccess: (message: ServerTextMessage) => void;
  readonly rejectValidatedError: (message: ServerErrorMessage) => void;
  readonly projectTombstoneIdentity: () => TombstoneValidationIdentity;
  readonly validateLateSuccess: (
    identity: TombstoneValidationIdentity,
    message: ServerTextMessage,
  ) => void;
  readonly validateLateError: (
    identity: TombstoneValidationIdentity,
    message: ServerErrorMessage,
  ) => void;
  readonly reject: (error: Error) => void;
}

interface TimedOutRequestTombstone {
  readonly requestId: RequestId;
  readonly requestKind: PendingRequestKind;
  readonly requestFingerprint: Sha256Hex;
  readonly effect: RequestEffect;
  readonly reconciliation: RequestKindMetadata<RequestKind>['reconciliation'];
  readonly responseTypes: readonly ServerTextMessage['type'][];
  readonly validationIdentity: TombstoneValidationIdentity;
  readonly validateLateSuccess: (
    identity: TombstoneValidationIdentity,
    message: ServerTextMessage,
  ) => void;
  readonly validateLateError: (
    identity: TombstoneValidationIdentity,
    message: ServerErrorMessage,
  ) => void;
  readonly expiresAtMs: number;
  readonly utf8Bytes: number;
}

export class HostError extends Error {
  override readonly name = 'HostError';
  constructor(readonly response: ServerErrorMessage) {
    super(response.message);
  }
}

export class RequestTimeoutError extends Error {
  override readonly name = 'RequestTimeoutError';
  readonly effect = 'read_only' as const;
  readonly reconciliation = 'discard' as const;
  constructor(
    readonly requestKind: Extract<
      PendingRequestKind,
      'GetState' | 'ListSessions' | 'GetSafetyState' |
      'PrepareRecoveryReview' | 'PrepareTeardownRepair' |
      'PrepareShutdown' | 'FinalizeShutdownPreparation'
    >,
    readonly requestId: RequestId,
    readonly requestFingerprint: Sha256Hex,
  ) {
    super(`request timed out for ${requestKind}`);
  }
}

export class MutationOutcomeUnknownError extends Error {
  override readonly name = 'MutationOutcomeUnknownError';
  constructor(
    readonly requestKind: PendingRequestKind,
    readonly requestId: RequestId,
    readonly requestFingerprint: Sha256Hex,
    readonly effect: Exclude<RequestEffect, 'read_only'>,
    readonly reconciliation:
      | 'detach_then_reattach'
      | 'get_state'
      | 'shutdown_coordinator',
  ) {
    super(`mutation outcome is unknown for ${requestKind}`);
  }
}

const MAX_PENDING_REQUESTS = 1_024;
const MAX_PENDING_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TIMED_OUT_TOMBSTONES = 1_024;
const MAX_TIMED_OUT_TOMBSTONE_BYTES = 256 * 1024;
const TIMED_OUT_TOMBSTONE_TTL_MS = 60_000;
const MAX_CONNECTION_REQUEST_IDS = 65_536;
const MAX_CONTROL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_OR_BINARY_BYTES = 1024 * 1024;
```

Set `binaryType='arraybuffer'` before open. `connect` installs handlers before opening, generates the `Hello.request_id`, sends exactly one `Hello`, and resolves only after a matching valid `AuthOk` whose host/data-directory IDs equal bootstrap, whose major is 2, whose minor is the negotiated minimum, and whose features are the exact valid intersection. A valid `protocol_major_mismatch` error moves to `protocol_mismatch` and closes only the socket. Other failures move to `disconnected`. Unknown request IDs are accepted only for unsolicited `Event` or lagged `ReplayChunk(request_id:null)`; an unknown correlated response is a protocol violation: `HostClient` closes the socket and emits `disconnected(reason='invalid_frame')` for that generation, and `HostProvider` schedules the fresh connection/snapshot.

Every WebSocket `onmessage` callback increments one connection-local `arrivalOrdinal` and synchronously emits a `HostTextEnvelope` or `HostStreamItem` before settling a correlated Promise. The strict parser supplies `canonicalKey` only for an `Event` envelope while the validated snake-case object still exists; snapshots, acknowledgements, and errors use the non-event envelope without a key. This preserves physical `ReplayChunk -> Attached -> binary` observation even when Promise continuations run in microtasks. Callbacks from a prior provider-owned connection generation are discarded before parsing or subscriber delivery.

`MutationOutcomeUnknownError` stores request kind, request ID, safe fingerprint, immutable effect, and reconciliation; it never stores a closure that retries. Only `reconcileUnknownDurableMutation` accepts an error statically narrowed to `effect='durable_mutation'` and `reconciliation='get_state'`, sends one new read-only `GetState` with a fresh request ID, and returns the snapshot. Attachment and shutdown errors cannot enter that API. The Phase 7 semantic action coordinator compares authoritative state with the intended mutation and decides only whether it committed, did not commit, or remains indeterminate; it never blindly resends the mutation. `sendAuthorizedShutdown` is deliberately narrower: Phase 7 may call it exactly once only after the native `confirm_shutdown` result is `authorized`; a timeout or disconnect is reported as unknown to the shutdown coordinator, which observes exact host/runtime/mutex release and never resends `Shutdown`.

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/host/HostClient.test.ts
```

Expected: all HostClient tests pass; no pending request or timer remains after each test.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/native/bootstrapContracts.ts ui/src/host/HostClient.ts ui/src/host/HostClient.test.ts ui/src/test/FakeWebSocket.ts ui/src/test/fixtures.ts
git commit -m "feat(ui): add bounded host transport" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Reduce complete snapshots and contiguous global events

**Files:**
- Create: `C:\Dev\TermX\ui\src\host\hostReducer.ts`
- Create: `C:\Dev\TermX\ui\src\host\hostReducer.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`

**Interfaces:**
- Consumes: decoded `AuthOkMessage`, `StateMessage`, and `EventMessage` from Task 2.
- Produces:
  ```ts
  export interface CanonicalHostSnapshot {
    readonly dataDirInstanceId: string;
    readonly hostInstanceId: HostInstanceId;
    readonly eventCursor: EventCursor;
    readonly nextCreationSequence: bigint;
    readonly layoutRevision: bigint;
    readonly layout: LayoutV1;
    readonly safetyRevision: bigint;
    readonly safetyState: SafetyStateV1;
    readonly sessions: ReadonlyMap<number, SessionInfoV2>;
    readonly profiles: readonly ProfileInfoV2[];
    readonly repairStatus: RepairStatusV1;
    readonly containmentStatus: ContainmentStatusV1;
  }

  export interface ReducedEventIdentity {
    readonly hostInstanceId: HostInstanceId;
    readonly eventId: bigint;
    readonly canonicalKey: Sha256Hex;
    readonly utf8Bytes: number;
  }

  export interface HostStore {
    readonly connection: HostClientState;
    readonly canonical: CanonicalHostSnapshot | null;
    readonly installedSnapshotCursor: EventCursor | null;
    readonly recentReducedEvents: readonly ReducedEventIdentity[];
    readonly recentReducedEventBytes: number;
    readonly resnapshotRequired: boolean;
    readonly resnapshotReason: ResnapshotReason | null;
  }

  export interface SequencedEventEnvelope {
    readonly message: EventMessage;
    readonly canonicalKey: Sha256Hex;
    readonly utf8Bytes: number;
  }

  export type HostStoreAction =
    | { readonly type: 'connection_changed'; readonly state: HostClientState }
    | { readonly type: 'snapshot_installed'; readonly snapshot: AuthOkMessage | StateMessage }
    | { readonly type: 'event_received'; readonly envelope: SequencedEventEnvelope }
    | { readonly type: 'resnapshot_requested'; readonly reason: ResnapshotReason }
    | { readonly type: 'cleared' };

  export type ResnapshotReason =
    | 'event_gap'
    | 'conflicting_duplicate'
    | 'host_instance_changed'
    | 'event_buffer_overflow'
    | 'invalid_event_transition'
    | 'invalid_snapshot';

  export const initialHostStore: HostStore;
  export function hostReducer(state: HostStore, action: HostStoreAction): HostStore;
  export function installSnapshot(message: AuthOkMessage | StateMessage): CanonicalHostSnapshot;
  export function reduceContiguousEvent(
    snapshot: CanonicalHostSnapshot,
    envelope: SequencedEventEnvelope,
  ): CanonicalHostSnapshot;
  ```
- `initialHostStore` is exactly the deeply frozen empty value `{ connection: { kind: 'idle' }, canonical: null, installedSnapshotCursor: null, recentReducedEvents: Object.freeze([]), recentReducedEventBytes: 0, resnapshotRequired: false, resnapshotReason: null }`. The reducer's `cleared` action returns that exact singleton; no consumer constructs an ambient empty store.
- Task 4 extends the Task 2 fixture module with a separately exported `eventEnvelope(message: EventMessage): SequencedEventEnvelope`; reducer tests import both `protocolFixtures` and `eventEnvelope`. This avoids declaring a Task 4 type in Task 2 while preserving one exact producer signature.
- Invariant: no mutation acknowledgement appears in `HostStoreAction`; TypeScript makes response-driven canonical mutation impossible through the public reducer API.

- [ ] **Step 1: Write failing atomic snapshot/event tests**

```ts
import { describe, expect, it } from 'vitest';
import { hostReducer, initialHostStore } from './hostReducer';
import { eventEnvelope, protocolFixtures } from '../test/fixtures';

 describe('hostReducer', () => {
  it('replaces the complete stale snapshot instead of merging fields', () => {
    const oldState = hostReducer(initialHostStore, {
      type: 'snapshot_installed',
      snapshot: protocolFixtures.authOk({ eventId: 9n, sessionIds: [1, 2] }),
    });
    const next = hostReducer(oldState, {
      type: 'snapshot_installed',
      snapshot: protocolFixtures.state({ eventId: 12n, sessionIds: [2] }),
    });
    expect([...next.canonical!.sessions.keys()]).toEqual([2]);
    expect(next.canonical!.eventCursor.eventId).toBe(12n);
  });

  it('reduces one contiguous event and ignores its byte-identical duplicate', () => {
    const base = hostReducer(initialHostStore, {
      type: 'snapshot_installed',
      snapshot: protocolFixtures.authOk({ eventId: 4n }),
    });
    const event = protocolFixtures.sessionCreatedEvent({ eventId: 5n, sessionId: 7 });
    const envelope = eventEnvelope(event);
    const once = hostReducer(base, { type: 'event_received', envelope });
    const twice = hostReducer(once, { type: 'event_received', envelope });
    expect(twice).toBe(once);
    expect(twice.canonical!.eventCursor.eventId).toBe(5n);
  });

  it('forces resnapshot for the same event ID with different canonical bytes', () => {
    const base = hostReducer(initialHostStore, {
      type: 'snapshot_installed',
      snapshot: protocolFixtures.authOk({ eventId: 4n }),
    });
    const once = hostReducer(base, {
      type: 'event_received',
      envelope: eventEnvelope(
        protocolFixtures.sessionCreatedEvent({ eventId: 5n, sessionId: 7 }),
      ),
    });
    const conflict = hostReducer(once, {
      type: 'event_received',
      envelope: eventEnvelope(
        protocolFixtures.sessionCreatedEvent({ eventId: 5n, sessionId: 8 }),
      ),
    });
    expect(conflict.resnapshotReason).toBe('conflicting_duplicate');
    expect(conflict.canonical).toBe(once.canonical);
  });

  it('does not reduce across a gap', () => {
    const base = hostReducer(initialHostStore, {
      type: 'snapshot_installed',
      snapshot: protocolFixtures.authOk({ eventId: 4n }),
    });
    const next = hostReducer(base, {
      type: 'event_received',
      envelope: eventEnvelope(
        protocolFixtures.sessionClosedEvent({ eventId: 6n, sessionId: 1 }),
      ),
    });
    expect(next.canonical).toBe(base.canonical);
    expect(next.resnapshotRequired).toBe(true);
    expect(next.resnapshotReason).toBe('event_gap');
  });
});
```

Add exact cases for host-instance change; event at/below the installed snapshot cursor with no retained identity; an evicted post-snapshot event above `installedSnapshotCursor` but at/below the current cursor becoming `conflicting_duplicate`; byte-identical duplicate with retained identity; conflicting duplicate; recent identity capacity of exactly 1,024 entries and 256 KiB canonical compact identity bytes with deterministic oldest-first eviction only after the canonical cursor advances; `SessionCreated` for an existing session; every resize/exit/close-state/close event against an unknown session; invalid lifecycle transitions; `SessionClosed` before exited/closing where forbidden by the schema; closing an exited session clears `exitCode`; layout and safety revisions that do not equal current revision plus one; all seven event variants; profiles replaced only by snapshot; and attempted mutation of source snapshot objects plus event-owned `SessionCreated.info`, `LayoutChanged.layout`, and `SafetyStateChanged.safetyState` after installation proving deep immutable copies.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/host/hostReducer.test.ts
```

Expected: reducer and canonical snapshot types do not exist.

- [ ] **Step 3: Implement atomic replacement and exact event handlers**

Install a snapshot by validating its complete domain invariants, then deep-cloning and deep-freezing every layout, safety, session, profile, repair, and containment object; construct a fresh `Map<number, SessionInfoV2>` whose values share no mutable source references. Set `installedSnapshotCursor` to the snapshot cursor and reset `recentReducedEvents` to empty because the snapshot is authoritative but does not provide canonical bytes for earlier events.

For every event require matching `hostInstanceId`. If `eventId === cursor + 1n`, validate the complete domain transition before creating any candidate: `SessionCreated` requires absence and its `info` is deep-cloned/frozen; resize/exit/close-state/close require the exact current session and permitted prior lifecycle; layout and safety revisions equal current revision plus one and their event-owned values are deep-cloned/frozen. Validate only fields actually carried by each event plus the stored session's legal lifecycle; do not require a nonexistent lifecycle-generation field on resize/exit/close events. `SessionCloseStateChanged` to `closing|close_uncertain` reconstructs the session without `exitCode`, preserving the invariant that only `exited` carries it. Unknown sessions, duplicate creation, revision skip/reuse, or forbidden lifecycle edge preserves the canonical snapshot object and requests `invalid_event_transition`. A forward gap requests `event_gap`. For `eventId <= cursor`, look up the exact `(hostInstanceId,eventId)` recent identity: equal branded JCS/SHA-256 key is an ignorable duplicate; different key is `conflicting_duplicate`; no retained identity is ignored only when the ID is at or below `installedSnapshotCursor.eventId`, otherwise it is `conflicting_duplicate` because an evicted post-baseline event cannot be proven byte-identical.

After one valid contiguous reduction, append `ReducedEventIdentity` using the exact wire-event canonical key and raw UTF-8 bytes. Retain at most 1,024 identities and 256 KiB of canonical compact identity JSON, evicting oldest event IDs deterministically after the canonical cursor has advanced; never evict the newest identity merely to accept an over-budget item. If one identity cannot fit the empty budget, request `event_buffer_overflow` before installing its transition. On every gap/change/invalid transition/cap failure, preserve the canonical snapshot byte-for-byte and set `resnapshotRequired`.

```ts
function reduceEventBody(
  snapshot: CanonicalHostSnapshot,
  body: LifecycleEventBody,
  cursor: EventCursor,
): CanonicalHostSnapshot {
  switch (body.type) {
    case 'SessionCreated':
      return { ...snapshot, eventCursor: cursor, sessions: withSession(snapshot.sessions, body.info) };
    case 'SessionResized':
      return { ...snapshot, eventCursor: cursor, sessions: updateSession(snapshot.sessions, body.sessionId, {
        cols: body.cols,
        rows: body.rows,
      }) };
    case 'SessionExited':
      return { ...snapshot, eventCursor: cursor, sessions: updateSession(snapshot.sessions, body.sessionId, {
        lifecycle: 'exited',
        exitCode: body.exitCode,
      }) };
    case 'SessionCloseStateChanged': {
      const current = requireSession(snapshot.sessions, body.sessionId);
      const { exitCode: _omittedExitCode, ...withoutExitCode } = current;
      return { ...snapshot, eventCursor: cursor, sessions: replaceSession(snapshot.sessions, {
        ...withoutExitCode,
        lifecycle: body.lifecycle,
      }) };
    }
    case 'SessionClosed':
      return { ...snapshot, eventCursor: cursor, sessions: withoutSession(snapshot.sessions, body.sessionId) };
    case 'LayoutChanged':
      return { ...snapshot, eventCursor: cursor, layoutRevision: body.revision, layout: body.layout };
    case 'SafetyStateChanged':
      return { ...snapshot, eventCursor: cursor, safetyRevision: body.revision, safetyState: body.safetyState };
  }
}
```

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/host/hostReducer.test.ts
```

Expected: complete snapshot and all seven event variants pass with strict cursor behavior.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/host/hostReducer.ts ui/src/host/hostReducer.test.ts ui/src/test/fixtures.ts
git commit -m "feat(ui): reduce canonical host events" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Integrate HostProvider reconnect, event buffering, and resnapshot

**Files:**
- Create: `C:\Dev\TermX\ui\src\native\nativeContracts.ts`
- Create: `C:\Dev\TermX\ui\src\native\nativeContracts.test.ts`
- Create: `C:\Dev\TermX\ui\src\native\invokeNativeRaw.ts`
- Create: `C:\Dev\TermX\ui\src\native\invokeNativeRaw.test.ts`
- Create: `C:\Dev\TermX\ui\src\host\reconnectPolicy.ts`
- Create: `C:\Dev\TermX\ui\src\host\HostProvider.tsx`
- Create: `C:\Dev\TermX\ui\src\host\HostProvider.test.tsx`
- Modify: `C:\Dev\TermX\ui\src\app\App.tsx`
- Modify: `C:\Dev\TermX\ui\src\main.tsx`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`

**Interfaces:**
- Consumes: pinned Phase 5's exact ten-command raw invoke boundary and Tasks 3-4. Each closed renderer DTO is strict-encoded to UTF-8 and passed as a `Uint8Array`; no ordinary JavaScript object reaches Tauri. Rust returns `tauri::ipc::Response::new(serialized_json)`, which pinned Tauri resolves to the parsed JavaScript object/array/scalar represented by that JSON. The adapter validates that returned `unknown` directly; it never `JSON.parse`s or `TextDecoder`s a success. Expected discovery, launch, authentication, ownership, mismatch, legacy, repair, cancellation, stale, and manual-intervention outcomes remain closed success values. Only malformed/oversized/unavailable/private-adapter failures reject with Phase 5 `NativeInvokeRejectionV1`. Phase 6 must not invent `NativeFailureV1`, `NativeBootstrapFailure`, `get_native_status`, or reuse `SafeRecoveryErrorV1` as a general invoke error.
- Produces:
  ```ts
  export type NativeCommandName =
    | 'bootstrap_host'
    | 'read_config'
    | 'write_config'
    | 'confirm_shutdown'
    | 'confirm_teardown_repair'
    | 'prepare_storage_repair'
    | 'confirm_storage_repair'
    | 'execute_storage_repair'
    | 'cancel_storage_repair'
    | 'get_storage_repair_status';

  export type ConfigContentHash =
    | 'missing:v1'
    | Sha256Fingerprint;

  export type StorageRepairModeV1 =
    | 'restore'
    | 'reset'
    | 'adopt'
    | 'containment_reboot';

  export type BootstrapHostRequestV1 = Readonly<Record<string, never>>;
  export type ReadConfigRequestV1 = Readonly<Record<string, never>>;

  export interface WriteConfigRequestV1 {
    readonly expected_content_hash: ConfigContentHash;
    readonly config: ConfigV2;
  }

  export interface ConfirmShutdownRequestV1 {
    readonly authorization: ShutdownAuthorizationV1;
  }

  // `Uuid` is imported from `../contracts/shared`. Rust uses `uuid::Uuid`
  // for every field below and for the matching result-side identities; the
  // containing closed DTO provides semantic meaning without disconnected brands.
  export interface ConfirmTeardownRepairRequestV1 {
    readonly preparation_id: Uuid;
  }

  export interface PrepareStorageRepairRequestV1 {
    readonly request_id: RequestId;
    readonly mode: StorageRepairModeV1;
    readonly record_id?: Uuid;
  }

  export interface ConfirmStorageRepairRequestV1 {
    readonly request_id: RequestId;
    readonly repair_id: Uuid;
    readonly plan_hash: Sha256Hex;
  }

  export interface ExecuteStorageRepairRequestV1 {
    readonly request_id: RequestId;
    readonly repair_id: Uuid;
    readonly plan_hash: Sha256Hex;
    readonly authorization_id: Uuid;
  }

  export interface CancelStorageRepairRequestV1 {
    readonly request_id: RequestId;
    readonly repair_id: Uuid;
    readonly plan_hash: Sha256Hex;
  }

  export interface GetStorageRepairStatusRequestV1 {
    readonly request_id: RequestId;
    readonly repair_id: Uuid;
  }

  // Imported from `./bootstrapContracts` and re-exported here; Task 3 is the
  // sole declaration/schema owner.
  export type { RendererHostBootstrapV1 } from './bootstrapContracts';
  export { rendererHostBootstrapV1Schema } from './bootstrapContracts';

  export type HistoricalRecoveryStatusV1 =
    | 'historical_only'
    | 'recoverable'
    | 'unrecoverable'
    | 'containment_uncertain';

  export interface RendererHistoricalSessionStatusV1 {
    readonly stable_tab_id?: string;
    readonly session_id: number;
    readonly recovery_status: HistoricalRecoveryStatusV1;
    readonly reason_code?: string;
  }

  export interface RendererStorageRepairRequiredV1 {
    readonly loaded_from: 'backup';
    readonly listener_scope: 'diagnostic_repair_only';
    readonly reason_code: string;
    readonly historical_sessions:
      readonly RendererHistoricalSessionStatusV1[];
    readonly containment_reboot_record_ids: readonly Uuid[];
  }

  export type BootstrapHostFailureCodeV1 =
    | 'discovery_failure'
    | 'host_launch_failure'
    | 'authentication_failure'
    | 'ownership_uncertain'
    | 'permission_denied'
    | 'bootstrap_conflict'
    | 'recovery_plan_too_large'
    | 'manual_intervention_required';

  export type BootstrapHostFailureCategoryV1 =
    | 'discovery'
    | 'launch'
    | 'authentication'
    | 'ownership'
    | 'permission'
    | 'recovery'
    | 'manual_intervention';

  export type BootstrapHostResultV1 =
    | {
        readonly outcome: 'ready';
        readonly bootstrap: RendererHostBootstrapV1;
      }
    | {
        readonly outcome: 'live_protocol_mismatch';
        readonly ui_version: string;
        readonly ui_protocol_major: number;
        readonly ui_protocol_minor: number;
        readonly host_version: string;
        readonly host_protocol_major: number;
        readonly host_protocol_minor: number;
      }
    | {
        readonly outcome: 'legacy_host_live';
        readonly host_version: string;
        readonly runtime_schema_version: number;
        readonly guidance_code: 'close_legacy_host_manually';
        readonly redacted_message: string;
      }
    | {
        readonly outcome: 'storage_repair_required';
        readonly repair: RendererStorageRepairRequiredV1;
      }
    | {
        readonly outcome: 'failed';
        readonly code: BootstrapHostFailureCodeV1;
        readonly category: BootstrapHostFailureCategoryV1;
        readonly retryable: boolean;
        readonly redacted_message: string;
      };

  export type ConfigValidationReasonV1 =
    | 'malformed_json'
    | 'invalid_type'
    | 'invalid_unicode'
    | 'non_finite_number'
    | 'excessive_depth'
    | 'excessive_nodes'
    | 'config_too_large'
    | 'invalid_scrollback_bytes'
    | 'invalid_default_profile_id'
    | 'invalid_profile_id'
    | 'invalid_extension_key'
    | 'invalid_argument_vector'
    | 'invalid_environment_expansion'
    | 'missing_environment_variable'
    | 'credential_bearing_argv';

  export interface InvalidConfigDetailV1 {
    readonly reason_code: ConfigValidationReasonV1;
    readonly argument_index?: number;
  }

  export type ReadConfigResultV1 =
    | {
        readonly outcome: 'ready';
        readonly config: ConfigV2;
        readonly content_hash: ConfigContentHash;
      }
    | {
        readonly outcome: 'invalid_config';
        readonly detail: InvalidConfigDetailV1;
      };

  export type WriteConfigResultV1 =
    | {
        readonly outcome: 'written';
        readonly content_hash: Sha256Fingerprint;
        readonly profiles_restart_required: boolean;
      }
    | {
        readonly outcome: 'config_conflict';
        readonly content_hash: ConfigContentHash;
        readonly config: ConfigV2;
      }
    | {
        readonly outcome: 'invalid_config';
        readonly detail: InvalidConfigDetailV1;
      };

  export type NativeInvokeRejectionCodeV1 =
    | 'invalid_native_request'
    | 'native_request_too_large'
    | 'native_response_too_large'
    | 'native_state_unavailable'
    | 'native_adapter_failure';

  export interface NativeInvokeRejectionV1 {
    readonly code: NativeInvokeRejectionCodeV1;
    readonly retryable: boolean;
    readonly redacted_message: string;
  }

  // Imported from `../contracts/shared` and re-exported here so this module is
  // the sole public native boundary: NativeShutdownAuthorizationResult,
  // NativeTeardownRepairResult, StorageRepairPrepared,
  // StorageRepairAuthorized, StorageRepairExecutionResultV1, and
  // StorageRepairStatusV1.

  export interface NativeRequestMap {
    readonly bootstrap_host: BootstrapHostRequestV1;
    readonly read_config: ReadConfigRequestV1;
    readonly write_config: WriteConfigRequestV1;
    readonly confirm_shutdown: ConfirmShutdownRequestV1;
    readonly confirm_teardown_repair: ConfirmTeardownRepairRequestV1;
    readonly prepare_storage_repair: PrepareStorageRepairRequestV1;
    readonly confirm_storage_repair: ConfirmStorageRepairRequestV1;
    readonly execute_storage_repair: ExecuteStorageRepairRequestV1;
    readonly cancel_storage_repair: CancelStorageRepairRequestV1;
    readonly get_storage_repair_status: GetStorageRepairStatusRequestV1;
  }

  export interface NativeResultMap {
    readonly bootstrap_host: BootstrapHostResultV1;
    readonly read_config: ReadConfigResultV1;
    readonly write_config: WriteConfigResultV1;
    readonly confirm_shutdown: NativeShutdownAuthorizationResult;
    readonly confirm_teardown_repair: NativeTeardownRepairResult;
    readonly prepare_storage_repair: StorageRepairPrepared;
    readonly confirm_storage_repair: StorageRepairAuthorized;
    readonly execute_storage_repair: StorageRepairExecutionResultV1;
    readonly cancel_storage_repair: StorageRepairExecutionResultV1;
    readonly get_storage_repair_status: StorageRepairStatusV1;
  }

  export interface NativeInvokePort {
    invoke(command: NativeCommandName, body: Uint8Array): Promise<unknown>;
  }

  import type { StrictSchema } from '../contracts/sharedSchemas';
  export type { StrictSchema } from '../contracts/sharedSchemas';

  export const NATIVE_INVOKE_REQUEST_SCHEMAS: {
    readonly [K in NativeCommandName]: StrictSchema<NativeRequestMap[K]>;
  };

  export const NATIVE_INVOKE_RESULT_SCHEMAS: {
    readonly [K in NativeCommandName]: StrictSchema<NativeResultMap[K]>;
  };

  export function encodeNativeRequest<K extends NativeCommandName>(
    command: K,
    request: NativeRequestMap[K],
  ): Uint8Array;

  export function decodeNativeResult<K extends NativeCommandName>(
    command: K,
    value: unknown,
  ): NativeResultMap[K];

  export function decodeNativeRejection(value: unknown): NativeInvokeRejectionV1;

  export function invokeNativeRaw<K extends NativeCommandName>(
    port: NativeInvokePort,
    command: K,
    request: NativeRequestMap[K],
  ): Promise<NativeResultMap[K]>;

  export class NativeInvokeError extends Error {
    override readonly name = 'NativeInvokeError';
    constructor(readonly rejection: NativeInvokeRejectionV1) {
      super(rejection.redacted_message);
    }
  }

  export class NativeResponseValidationError extends Error {
    override readonly name = 'NativeResponseValidationError';
    constructor(
      readonly command: NativeCommandName,
      readonly reasonCode: 'invalid_native_response',
    ) {
      super(`invalid native response for ${command}`);
    }
  }

  export interface ReconnectPolicy {
    readonly baseDelayMs: 250;
    readonly maximumDelayMs: 5_000;
    readonly jitterRatio: 0.20;
  }

  export interface HostContextValue {
    readonly store: HostStore;
    readonly client: HostClient | null;
    readonly connectionGeneration: ConnectionGeneration | null;
    readonly request: <K extends RequestKind>(
      request: RequestPayloadOf<K>,
      options?: RequestOptions,
    ) => Promise<RequestResponseMap[K]>;
    readonly reconnectNow: () => void;
  }

  export function HostProvider(props: HostProviderProps): JSX.Element;
  export function useHost(): HostContextValue;
  export function useCanonicalHost(): CanonicalHostSnapshot | null;
  export function useSession(sessionId: number | null): SessionInfoV2 | null;
  export function useHostCompatibility(): HostCompatibilityView;
  export function reconnectDelay(attempt: number, randomUnit: number, policy?: ReconnectPolicy): number;
  ```
- `nativeContracts.ts` is the sole renderer public definition site for every Phase 5 native request/result/rejection DTO; shared nested types/schemas are imported from `contracts/shared.ts` and `contracts/sharedSchemas.ts`, not redeclared. TypeScript property names are the exact recursive `snake_case` native JSON keys shown above. `encodeNativeRequest` validates the closed request first, maps no alternate aliases, uses `JSON.stringify` only on the validated wire DTO, and returns `new TextEncoder().encode(json)`. `BootstrapHostRequestV1` and `ReadConfigRequestV1` encode exactly `{}`; null, omitted body, arrays, and any property reject. `PrepareStorageRepairRequestV1` enforces `record_id` present exactly for `mode === 'containment_reboot'` and absent for `restore|reset|adopt`; explicit `record_id: undefined` or `null` rejects. Every `request_id`, repair/preparation/authorization ID, hash, canonical decimal string, timestamp, enum, cap, and nested Config/StorageRepair/Shutdown field uses the same strict validator frozen by Tasks 2-4 and Phases 1-5. No type appearing in `NativeRequestMap` or `NativeResultMap` may remain ambient, inferred, duplicated, or undefined. If Phase 7 wants camelCase view models, it defines explicit functions such as `toStorageRepairViewModel(validatedWire)` after native result validation; such view models never enter `NativeRequestMap`, `NativeResultMap`, `encodeNativeRequest`, or `decodeNativeResult`.
- `NATIVE_INVOKE_REQUEST_SCHEMAS` and `NATIVE_INVOKE_RESULT_SCHEMAS` are concrete mapped objects whose values are `z.ZodType<...>` instances, not declarations without initializers. Native result schemas strict-validate every variant recursively, including the complete allowed `StorageRepairPreviewV1`/authorization identity fields. `decodeNativeRejection` uses one strict schema and enforces the 1,024-byte `redacted_message` cap. `invokeNativeRaw` catches only the invoke Promise rejection, validates it through `decodeNativeRejection`, and throws `NativeInvokeError`; a success value that fails its command result schema throws `NativeResponseValidationError`, never masquerades as a Tauri rejection.
- Task 5 extends Task 3's `HostFixture` with exact provider/native support: readonly `native` and `dependencies`; private `providerRenderResult: RenderResult | null`; assertion getter `renderResult(): RenderResult`; methods `openAndBeginAuth`, `deliverAuthOkAndEventInOneMacrotask`, `physicalInboundTypes`, `sessionCreatedEvent`, `replyProtocolMajorMismatch`, and `nativeInvokeNames`; plus static `renderReadyProvider(): Promise<RenderedHostFixture>`. `RenderedHostFixture` is `HostFixture & { renderResult(): RenderResult }` and the static constructor returns it only after assigning the private render result and passing its assertion. A base `new HostFixture()` remains valid before anything renders and has no definite-assignment assertion. `dependencies.nextRequestId` delegates to the fixture's deterministic source, `nextConnectionGeneration` produces strictly increasing branded values, and `native` records only the exact command name plus a copied `Uint8Array`; tests decode requests through `decodeNativeRequestForTest`, never through ad hoc JSON casts.
- `HostProviderProps`, compatibility state, and probe ownership are exact:
  ```ts
  export interface HostProviderDependencies {
    readonly native: NativeInvokePort;
    readonly socketFactory: WebSocketFactory;
    readonly clock: HostClock;
    readonly nextRequestId: () => RequestId;
    readonly nextConnectionGeneration: () => ConnectionGeneration;
    readonly randomUnit: () => number;
  }

  export interface HostProviderProps {
    readonly dependencies: HostProviderDependencies;
    readonly children: React.ReactNode;
  }

  export type HostCompatibilityView =
    | { readonly kind: 'compatible' }
    | {
        readonly kind: 'protocol_mismatch';
        readonly uiProtocolMajor: number;
        readonly hostProtocolMajor: number;
      }
    | {
        readonly kind: 'legacy_host';
        readonly guidanceCode: 'close_legacy_host_manually';
      };

  type HostProviderLifecycle =
    | { readonly kind: 'bootstrapping' }
    | { readonly kind: 'connecting'; readonly generation: ConnectionGeneration }
    | { readonly kind: 'installing_snapshot'; readonly generation: ConnectionGeneration }
    | { readonly kind: 'ready'; readonly generation: ConnectionGeneration }
    | { readonly kind: 'retrying'; readonly attempt: number }
    | { readonly kind: 'compatibility'; readonly view: HostCompatibilityView }
    | { readonly kind: 'storage_repair_required'; readonly repair: RendererStorageRepairRequiredV1 }
    | { readonly kind: 'failed'; readonly result: Extract<BootstrapHostResultV1, { outcome: 'failed' }> };
  ```
  `Probe` is declared inside `HostProvider.test.tsx`; it calls `useHost()` and renders `cursor`, `sessions`, and `compatibility` test IDs. It is test support, not production API.
- Invariant: the provider has no shutdown/restart/recovery action in its automatic connection path.

- [ ] **Step 1: Write failing buffering/reconnect/mismatch tests**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HostProvider } from './HostProvider';
import { HostFixture } from '../test/fixtures';

 describe('HostProvider', () => {
  it('buffers an event physically after AuthOk but before React flushes the baseline', async () => {
    const fixture = new HostFixture();
    render(<HostProvider dependencies={fixture.dependencies}><Probe /></HostProvider>);
    await fixture.openAndBeginAuth();

    fixture.deliverAuthOkAndEventInOneMacrotask(
      { eventId: 3n },
      fixture.sessionCreatedEvent({ eventId: 4n, sessionId: 4 }),
    );

    expect(fixture.physicalInboundTypes()).toEqual(['AuthOk', 'Event']);
    expect(await screen.findByTestId('cursor')).toHaveTextContent('4');
    expect(screen.getByTestId('sessions')).toHaveTextContent('4');
  });

  it('unmount closes only the renderer socket and sends no shutdown or close', async () => {
    const fixture = await HostFixture.renderReadyProvider();
    fixture.renderResult().unmount();
    expect(fixture.sentTypes()).not.toContain('Shutdown');
    expect(fixture.sentTypes()).not.toContain('CloseSession');
    expect(fixture.socket.closeCalls).toHaveLength(1);
  });

  it('protocol mismatch is terminal and invokes no destructive native command', async () => {
    const fixture = new HostFixture();
    render(<HostProvider dependencies={fixture.dependencies}><Probe /></HostProvider>);
    await fixture.openAndBeginAuth();
    fixture.replyProtocolMajorMismatch({ hostMajor: 3 });
    expect(await screen.findByTestId('compatibility')).toHaveTextContent('protocol_mismatch');
    expect(fixture.nativeInvokeNames()).toEqual(['bootstrap_host']);
    expect(fixture.sentTypes()).toEqual(['Hello']);
  });
});
```

Add `nativeContracts.test.ts` and `invokeNativeRaw.test.ts` cases proving: `bootstrap_host` and `read_config` encode to the exact two bytes `{}` and reject null/array/extra-key bodies; `write_config` emits exactly `expected_content_hash` plus the closed `config`; `confirm_shutdown` and `confirm_teardown_repair` use exactly the recursive `snake_case` keys above; all five StorageRepair commands use exact recursive `snake_case` keys; `containment_reboot` requires one valid `record_id` while every other mode rejects a present, null, or explicitly undefined `record_id`; each request ID/UUID/hash/config/shutdown/storage nested field rejects malformed or unknown values before invoking the port; every map row accepts only its matching request/result at compile time; the adapter strict-encodes the request once to UTF-8; it passes that `Uint8Array` directly to `NativeInvokePort`; it rejects a runtime-unallowlisted command before invocation even when JavaScript bypasses TypeScript; Phase 5 lexical fixtures containing literal duplicates, escaped-equivalent duplicates (`"a"` plus `"\\u0061"`), nested duplicates, and object-in-array duplicates are accepted only through a test-only `invokeEncodedRequestForTest(command, raw: Uint8Array)` seam and are rejected by Rust before service dispatch; ordinary closed DTO encoding cannot claim to manufacture duplicate lexical keys; success decoding receives an already-parsed `unknown` object and never calls `JSON.parse`; each command rejects unknown/missing/invalid nested result fields; `decodeNativeRejection` accepts only the five closed rejection codes and 1,024-byte redacted-message bound; a malformed resolved value is a local `NativeResponseValidationError`, while a rejected Promise containing a valid `NativeInvokeRejectionV1` becomes `NativeInvokeError`; and neither path logs raw request/result/rejection values. Response duplicate-key lexical rejection remains a Rust serializer invariant, not a renderer test: Tauri has parsed JSON before Promise resolution, so Phase 6 cannot recover response lexical bytes.

Add HostProvider tests for exact capped jitter values, same-bootstrap reconnect, fresh `AuthOk` replacement after reconnect, event-gap disconnect followed by `GetState`/fresh-snapshot behavior, event-buffer item cap 128 and byte cap 2 MiB, disconnected request rejection, stale socket callback suppression by connection generation, and no provider action after UI remount.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/native/nativeContracts.test.ts src/native/invokeNativeRaw.test.ts src/host/HostProvider.test.tsx
```

Expected: the raw native invoke adapter, provider, selectors, buffering, and reconnect policy do not exist.

- [ ] **Step 3: Implement generation-scoped connection orchestration**

Implement `invokeNativeRaw` as the sole renderer/Tauri boundary over an injected `NativeInvokePort`: validate the concrete `NativeRequestMap[K]`, strict-encode it to one UTF-8 `Uint8Array`, pass those bytes directly as Tauri's raw invoke body, await `unknown`, and validate that already-parsed value with `NATIVE_INVOKE_RESULT_SCHEMAS[command]`. Catch only the Promise rejection boundary, strict-decode it with `decodeNativeRejection`, and throw `NativeInvokeError`; a resolved malformed success throws `NativeResponseValidationError`. Do not call `JSON.parse`, accept a generic result type, or use `as NativeResultMap[K]`. The production port is a tiny wrapper around pinned `@tauri-apps/api/core.invoke<unknown>(command, body)`.

On mount, call `invokeNativeRaw(nativePort, 'bootstrap_host', {})` once, create a generation-numbered `HostClient`, subscribe to text/state/stream before `connect`, and keep the provider in `installing_snapshot` until the React reducer has committed the `AuthOk` baseline. HostClient physically emits parsed callbacks synchronously in wire order before settling `connect`; therefore an `Event` callback that arrives after `AuthOk` but before the Promise continuation/React state flush is appended to the current generation's bounded install buffer. After the baseline reducer commit, drain buffered events above the cursor in physical `arrivalOrdinal` order, then atomically switch that generation to direct event reduction. A pre-`AuthOk` `Event` is a host protocol violation and disconnects; it is not the race fixture. Any gap/overflow invalidates the generation and starts a fresh same-bootstrap connection. Reconnect delays are `min(250 * 2^attempt, 5000)` with deterministic ±20% jitter injected through dependencies. When repeated connection failure requires native reclassification, call `bootstrap_host` again through the same mapped raw adapter; a new host ID always installs a fresh snapshot and never launches recovery from React.

```ts
interface SnapshotInstallBuffer {
  readonly connectionGeneration: ConnectionGeneration;
  readonly authOk: AuthOkMessage;
  readonly events: readonly HostTextEnvelope[];
  readonly eventUtf8Bytes: number;
}

function installAuthBaseline(
  currentGeneration: ConnectionGeneration,
  pending: SnapshotInstallBuffer,
  dispatch: React.Dispatch<HostStoreAction>,
): void {
  if (pending.connectionGeneration !== currentGeneration) return;
  dispatch({ type: 'snapshot_installed', snapshot: pending.authOk });
  for (const envelope of [...pending.events].sort(
    (left, right) => left.arrivalOrdinal < right.arrivalOrdinal ? -1 : 1,
  )) {
    if (envelope.kind !== 'event') continue;
    if (envelope.message.eventId > pending.authOk.eventCursor.eventId) {
      dispatch({ type: 'event_received', envelope });
    }
  }
}
```

`App.tsx` renders explicit loading, disconnected/retrying, repair-required, ready, and protocol-mismatch shells from selectors. It does not add sidebar/settings/recovery actions until Phase 7.

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/native/nativeContracts.test.ts src/native/invokeNativeRaw.test.ts src/host/HostProvider.test.tsx src/host/HostClient.test.ts src/host/hostReducer.test.ts
```

Expected: provider orchestration passes; unmount and mismatch traces contain no destructive message/invoke.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/native/nativeContracts.ts ui/src/native/nativeContracts.test.ts ui/src/native/invokeNativeRaw.ts ui/src/native/invokeNativeRaw.test.ts ui/src/host/reconnectPolicy.ts ui/src/host/HostProvider.tsx ui/src/host/HostProvider.test.tsx ui/src/app/App.tsx ui/src/main.tsx ui/src/test/fixtures.ts
git commit -m "feat(ui): reconnect through canonical snapshots" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Implement bounded replay/live output scheduling and offset reconciliation

**Files:**
- Create: `C:\Dev\TermX\ui\src\terminal\OutputWriteQueue.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\OutputWriteQueue.test.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\ReplayEnvelopeInbox.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\ReplayEnvelopeInbox.test.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\offsets.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\offsets.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\FakeTerminal.ts`

**Interfaces:**
- Consumes: decoded replay payloads and binary output intervals.
- Produces:
  ```ts
  export type OutputSource = 'replay' | 'live';

  export interface OutputSlice {
    readonly source: OutputSource;
    readonly connectionGeneration: ConnectionGeneration;
    readonly arrivalOrdinal: bigint;
    readonly startOffset: bigint;
    readonly bytes: Uint8Array;
  }

  export type OffsetDecision =
    | { readonly kind: 'drop'; readonly nextOffset: bigint }
    | { readonly kind: 'write'; readonly startOffset: bigint; readonly bytes: Uint8Array; readonly nextOffset: bigint }
    | { readonly kind: 'ring_evicted'; readonly authoritativeStart: bigint; readonly bytes: Uint8Array; readonly nextOffset: bigint }
    | { readonly kind: 'live_gap'; readonly expectedOffset: bigint; readonly actualOffset: bigint };

  export function reconcileOffset(
    expectedOffset: bigint,
    slice: Pick<OutputSlice, 'source' | 'startOffset' | 'bytes'>,
  ): OffsetDecision;

  export type PresentationWrite =
    | {
        readonly kind: 'source';
        readonly sourceStart: bigint;
        readonly sourceLength: number;
        readonly bytes: Uint8Array;
      }
    | { readonly kind: 'marker'; readonly text: string };

  export interface EncodedReplayEnvelope {
    readonly connectionGeneration: ConnectionGeneration;
    readonly arrivalOrdinal: bigint;
    readonly rawUtf8Bytes: number;
    readonly message: ReplayChunkMessage;
  }

  export interface ReplayEnvelopeInboxMetrics {
    readonly itemCount: number;
    readonly encodedUtf8Bytes: number;
  }

  export type ReplayEnvelopeOverflowReason =
    | 'item_cap'
    | 'byte_cap';

  export class ReplayEnvelopeOverflowError extends Error {
    override readonly name = 'ReplayEnvelopeOverflowError';
    constructor(readonly reasonCode: ReplayEnvelopeOverflowReason) {
      super(`encoded replay inbox overflow: ${reasonCode}`);
    }
  }

  export type ReplayEnvelopeProtocolReason =
    | 'stale_generation'
    | 'invalid_raw_utf8_bytes'
    | 'message_cap'
    | 'nonmonotonic_arrival';

  export class ReplayEnvelopeProtocolError extends Error {
    override readonly name = 'ReplayEnvelopeProtocolError';
    constructor(readonly reasonCode: ReplayEnvelopeProtocolReason) {
      super(`encoded replay envelope rejected: ${reasonCode}`);
    }
  }

  export class ReplayEnvelopeInbox {
    constructor(connectionGeneration: ConnectionGeneration);
    enqueue(envelope: EncodedReplayEnvelope): void;
    peek(): EncodedReplayEnvelope | null;
    shift(): EncodedReplayEnvelope | null;
    clear(): void;
    metrics(): ReplayEnvelopeInboxMetrics;
  }

  export type OutputSchedulingMode = 'initial_replay' | 'active';

  export interface OutputWriteQueueMetrics {
    readonly totalItemCount: number;
    readonly replayItemCount: number;
    readonly liveItemCount: number;
    readonly replayBytes: number;
    readonly liveBytes: number;
    readonly callbackCount: number;
    readonly queueOwnedDecodedBytes: number;
  }

  export type OutputQueueOverflowReason =
    | 'replay_item_cap'
    | 'replay_byte_cap'
    | 'live_item_cap'
    | 'live_byte_cap'
    | 'callback_cap';

  export class OutputQueueOverflowError extends Error {
    override readonly name = 'OutputQueueOverflowError';
    constructor(readonly reasonCode: OutputQueueOverflowReason) {
      super(`decoded output queue overflow: ${reasonCode}`);
    }
  }

  export type OutputQueueTakeResult =
    | { readonly kind: 'empty' }
    | {
        readonly kind: 'blocked';
        readonly expectedOffset: bigint;
        readonly earliestBlockedArrivalOrdinal: bigint;
        readonly actualOffset: bigint;
      }
    | {
        readonly kind: 'drop';
        readonly source: OutputSource;
        readonly arrivalOrdinal: bigint;
        readonly nextOffset: bigint;
      }
    | {
        readonly kind: 'write';
        readonly source: OutputSource;
        readonly arrivalOrdinal: bigint;
        readonly decision: Extract<
          OffsetDecision,
          { readonly kind: 'write' | 'ring_evicted' }
        >;
        readonly sourceBytes: Uint8Array;
        readonly complete: () => void;
        readonly abort: () => void;
      };

  export class OutputWriteQueue {
    constructor(connectionGeneration: ConnectionGeneration);
    setSchedulingMode(mode: OutputSchedulingMode): void;
    enqueueReplay(slice: OutputSlice): void;
    enqueueLive(slice: OutputSlice): void;
    takeNext(expectedOffset: bigint): OutputQueueTakeResult;
    clear(): void;
    metrics(): OutputWriteQueueMetrics;
  }
  ```
- Exact constants are `MAX_ENCODED_REPLAY_ITEMS = 16`, `MAX_ENCODED_REPLAY_BYTES = 16 * 1024 * 1024`, `MAX_DECODED_REPLAY_ITEMS = 1`, `MAX_DECODED_REPLAY_BYTES = 512 * 1024`, `MAX_LIVE_ITEMS = 4_096`, `MAX_LIVE_BYTES = 2 * 1024 * 1024`, `MAX_ACTIVE_WRITE_CALLBACKS = 1`, and `DECODE_SCRATCH_BYTES = 512 * 1024`. The decoded queue can therefore retain at most 4,097 items: 4,096 live plus one replay item. Zero-length live or replay slices are protocol violations and consume no reservation. Every item and byte reservation occurs before insertion; plus-one rejection leaves every metric unchanged.
- Invariant: `ReplayEnvelopeInbox` independently owns at most 16 complete encoded envelopes and 16 MiB of exact `rawUtf8Bytes`. It retains a private `lastAdmittedArrivalOrdinal: bigint | null` for the lifetime of its fixed `connectionGeneration`. Every candidate must have an ordinal strictly greater than that historical watermark, including after earlier envelopes have been `shift()`ed or the inbox has been `clear()`ed. Only constructing the replacement inbox for a new connection generation resets the watermark to `null`; `shift()` and `clear()` release item/byte reservations but never lower or reset it. The watermark advances only after every generation, nonzero-length, per-message-cap, item-cap, byte-cap, and monotonicity check succeeds, so a rejected candidate leaves both metrics and the watermark unchanged. Replay-ID/chunk/request sequencing remains solely in `ReplaySequenceValidator`; the inbox does not invent a second competing sequence machine. It stores the already parsed `ReplayChunkMessage` and its one retained `ValidatedReplayBase64.encoded` string; it never creates a second encoded copy or decoded array. `shift`/`clear` releases each item and byte reservation exactly once.
- Invariant: whenever the decoded replay lane is empty, the controller removes the inbox head first, thereby releasing encoded ownership, decodes into the one reusable 512 KiB scratch, reserves the decoded item slot/bytes, synchronously copies the accepted interval into one queue-owned replay item, and only then publishes it. The scratch allocation remains `TerminalController`-owned for the controller lifetime and is not reported by `OutputWriteQueue.metrics()`. `OutputWriteQueue` reports only its queue-owned one 512 KiB decoded replay item plus 2 MiB/4,096 live items through `queueOwnedDecodedBytes = replayBytes + liveBytes`; those categories never alias. `TerminalController.metrics()` adds the fixed 512 KiB scratch to produce `pendingDecodedBytes`, which is therefore exactly bounded by 3 MiB. Serial drain creates at most one active xterm callback; there is no retained callback list proportional to queued items.
- `OutputWriteQueue.takeNext(expectedOffset)` is the sole scheduler/ownership-transfer seam; the queue never calls xterm and never owns presentation transforms. Calls are invalid while a prior `kind:'write'` lease is unsettled and throw `OutputQueueOverflowError('callback_cap')` without changing queue state. In `initial_replay`, it considers only the lowest-ordinal replay item and returns `empty` when none exists; buffered live items remain owned but ineligible until the controller switches to `active`. In `active`, it evaluates items in increasing `arrivalOrdinal`: full duplicates are removed/released and returned as `drop`; overlap/exact-continuation writes are eligible; a forward-gap live item is retained and skipped only while searching later replay items for the first replay decision that can fill or authoritatively advance the missing interval; other later live items and later replay items behind an already eligible earlier item cannot leapfrog. If nothing is eligible, return `blocked` with the earliest retained live gap. A replay forward advance is returned as the `ring_evicted` write decision. The controller alone owns `expectedOffset`: it assigns a drop's `nextOffset` immediately, and assigns a write decision's `nextOffset` only after every marker/source `Terminal.write` callback for that lease completes. `sourceBytes` is the queue-owned accepted source interval referenced by the decision; it stays reserved and immutable until `complete()` or `abort()` releases it exactly once. `complete()` and `abort()` are idempotence-guarded mutually exclusive settlement operations; callback count is one from lease creation until settlement. `clear()` aborts the lease and releases all retained items exactly once.
- Invariant: `PresentationWrite.kind='source'` alone advances authoritative offsets. Generated ring-eviction, logical-line, and scrollback markers are `kind='marker'` and never change `nextOffset`.

- [ ] **Step 1: Write failing overlap/gap/bound tests**

```ts
import { describe, expect, it } from 'vitest';
import { reconcileOffset } from './offsets';
import { OutputWriteQueue, OutputQueueOverflowError } from './OutputWriteQueue';

 describe('reconcileOffset', () => {
  it('drops a full duplicate and trims a partial overlap', () => {
    expect(reconcileOffset(10n, { source: 'live', startOffset: 5n, bytes: bytes(5) }))
      .toEqual({ kind: 'drop', nextOffset: 10n });
    const partial = reconcileOffset(10n, {
      source: 'live', startOffset: 8n, bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(partial).toMatchObject({ kind: 'write', startOffset: 10n, nextOffset: 12n });
    if (partial.kind === 'write') expect([...partial.bytes]).toEqual([3, 4]);
  });

  it('classifies replay advance as eviction and live advance as a gap', () => {
    expect(reconcileOffset(10n, { source: 'replay', startOffset: 20n, bytes: bytes(2) }).kind)
      .toBe('ring_evicted');
    expect(reconcileOffset(10n, { source: 'live', startOffset: 20n, bytes: bytes(2) }).kind)
      .toBe('live_gap');
  });
});

 describe('OutputWriteQueue', () => {
  it('rejects one byte beyond the live backlog cap using only valid frames', () => {
    const generation = connectionGeneration(1);
    const queue = new OutputWriteQueue(generation);
    const payloadLimit = 1_048_563;
    const admitted = [payloadLimit, payloadLimit, 26] as const;
    let startOffset = 0n;
    let arrivalOrdinal = 1n;

    for (const length of admitted) {
      queue.enqueueLive({
        source: 'live',
        connectionGeneration: generation,
        arrivalOrdinal,
        startOffset,
        bytes: bytes(length),
      });
      startOffset += BigInt(length);
      arrivalOrdinal += 1n;
    }

    expect(queue.metrics().liveBytes).toBe(2 * 1024 * 1024);
    expect(() => queue.enqueueLive({
      source: 'live',
      connectionGeneration: generation,
      arrivalOrdinal,
      startOffset,
      bytes: bytes(1),
    })).toThrow(OutputQueueOverflowError);
    expect(queue.metrics()).toMatchObject({
      liveBytes: 2 * 1024 * 1024,
      liveItemCount: 3,
      totalItemCount: 3,
    });
  });

  it('rejects item 4097 even when the live-byte cap has room', () => {
    const generation = connectionGeneration(1);
    const queue = new OutputWriteQueue(generation);
    for (let index = 0; index < 4_096; index += 1) {
      queue.enqueueLive({
        source: 'live',
        connectionGeneration: generation,
        arrivalOrdinal: BigInt(index + 1),
        startOffset: BigInt(index),
        bytes: bytes(1),
      });
    }
    expect(() => queue.enqueueLive({
      source: 'live',
      connectionGeneration: generation,
      arrivalOrdinal: 4_097n,
      startOffset: 4_096n,
      bytes: bytes(1),
    })).toThrow(OutputQueueOverflowError);
    expect(queue.metrics().liveItemCount).toBe(4_096);
  });
});
```

Add `ReplayEnvelopeInbox` tests for 16 envelopes accepted, item 17 rejected without retention, exactly 16 MiB aggregate `rawUtf8Bytes` accepted, plus-one byte rejected without retention, each individual envelope still subject to the 1 MiB message cap in Task 2, encoded reservation released before decoded publication, up to 16 encoded envelopes permitted while the prior decoded item awaits its write callback, strictly increasing arrival ordinals, stale-generation rejection, and exact `shift`/`clear` accounting. The historical-watermark RED case must admit ordinal `10n`, shift it, reject ordinal `9n`, and prove metrics unchanged; a second case must admit `10n`, clear the inbox, reject `9n`, then admit `11n`, proving `clear()` releases ownership without resetting connection-lifetime monotonicity. A replacement inbox constructed with the next `ConnectionGeneration` accepts its first ordinal independently. Item/byte/per-message rejection tests must also admit the next valid greater ordinal afterward, proving rejected candidates do not advance the watermark. Replay ID, request ID, chunk index, offset continuity, final-chunk uniqueness, and interleaving rejection are tested only through `ReplaySequenceValidator`. Add decoded-queue tests for initial-replay priority over `Attached`/live, active lagged scheduling by arrival plus offset eligibility, one-replay-item enforcement, 512 KiB plus one decoded replay rejection, 4,096 live items and item 4,097 rejection, zero-length rejection, scratch mutation after enqueue proving queue ownership, exactly one active callback lease, complete-before-abort, abort-before-complete, clear accounting, repeated `takeNext` during an unsettled lease rejecting with `callback_cap` without mutation, stale-generation abort, legal multi-frame byte overflow, and plus-one rejection leaving every metric unchanged. Scheduler tests must assert exact `takeNext(expectedOffset)` results for: full-duplicate release; partial-overlap trim; exact continuation; replay ring eviction; earliest live forward gap retained while a later replay fills it; the same blocked live item becoming eligible after the replay lease completes and the controller passes the new expected offset; no later live leapfrog; initial-replay mode withholding every live item; and `blocked` reporting the earliest retained gap when no replay can advance it.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/terminal/offsets.test.ts src/terminal/ReplayEnvelopeInbox.test.ts src/terminal/OutputWriteQueue.test.ts
```

Expected: queue and interval reconciler do not exist.

- [ ] **Step 3: Implement half-open interval reconciliation and serial writes**

`ReplayEnvelopeInbox.enqueue` checks the fixed `ConnectionGeneration`, `rawUtf8Bytes > 0`, the Task 2 per-message cap, one of 16 item slots, the 16 MiB aggregate byte cap, and `arrivalOrdinal > lastAdmittedArrivalOrdinal` before mutating state. After all checks pass, it atomically reserves the item and exact `rawUtf8Bytes`, stores the envelope, and assigns `lastAdmittedArrivalOrdinal = envelope.arrivalOrdinal`. `shift()` and `clear()` release reservations exactly once but preserve that historical watermark; only replacement by a newly constructed inbox for a new connection generation resets it. Item/byte overflow, stale generation, invalid length, or nonmonotonic arrival throws `ReplayEnvelopeOverflowError`/`ReplayEnvelopeProtocolError` without retaining the candidate or changing metrics/watermark. Sequence validity is not duplicated here: `ReplaySequenceValidator` accepts or rejects each head before decode.

Treat each decoded slice as `[startOffset, startOffset + bytes.byteLength)`. Duplicate/overlap decisions use `bigint`; convert to `number` only after proving the trimmed prefix is at most the current `Uint8Array.byteLength`. When the decoded replay lane is empty, `shift` one encoded envelope first, release its encoded ownership, decode through the one reusable scratch, then atomically reserve and copy the accepted decoded bytes before publishing the sole replay item. Do not decode the next envelope until the prior decoded replay write callback releases that lane; the remaining encoded envelopes stay bounded in the inbox.

In `initial_replay` mode, `takeNext` exposes only the lowest-ordinal replay item: no buffered `Attached` or live item writes before the final replay lease completes and the controller explicitly calls `setSchedulingMode('active')`. In `active` mode, `takeNext(expectedOffset)` chooses the lowest `arrivalOrdinal` item that is offset-eligible. An earlier live full duplicate is removed and returned as `drop`; an earlier partial overlap or exact continuation is returned as `write` before any later replay. An earlier forward-gap live item remains retained without writing or advancing; the scheduler may inspect later replay items only until it finds the first replay decision that fills or visibly advances that missing interval. After that replay lease completes and the controller advances `expectedOffset`, it calls `takeNext` again and the blocked live item is re-evaluated. No later live item leapfrogs a gap, and no later replay leaps ahead of an earlier eligible live item. After the final lagged replay callback, the controller drains or rejects every lower-ordinal retained item before input reopens.

Reserve live item and byte caps before insertion. A `drop` releases queue-owned item/bytes before return. A `write` transfers one lease while retaining its exact queue reservation; `complete()` releases after the controller has received the final xterm callback and advanced its offset, while `abort()` releases without advancing. The fixed scratch allocation remains counted until controller disposal. One lease-local `settled` boolean guards complete/abort exactly once; `clear()` calls `abort()` for an active lease and releases every remaining decoded reservation once. AbortSignal ownership belongs to TerminalController: it calls `lease.abort()` on operation invalidation and ignores any later xterm callback by switch/connection generation.

```ts
const MAX_ENCODED_REPLAY_ITEMS = 16;
const MAX_ENCODED_REPLAY_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_REPLAY_ITEMS = 1;
const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_LIVE_ITEMS = 4_096;
const MAX_LIVE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_WRITE_CALLBACKS = 1;
const DECODE_SCRATCH_BYTES = 512 * 1024;
```

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/terminal/offsets.test.ts src/terminal/ReplayEnvelopeInbox.test.ts src/terminal/OutputWriteQueue.test.ts
```

Expected: every offset and exact cap boundary passes; queue metrics return to zero after drain/clear.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/terminal/OutputWriteQueue.ts ui/src/terminal/OutputWriteQueue.test.ts ui/src/terminal/ReplayEnvelopeInbox.ts ui/src/terminal/ReplayEnvelopeInbox.test.ts ui/src/terminal/offsets.ts ui/src/terminal/offsets.test.ts ui/src/test/FakeTerminal.ts
git commit -m "feat(ui): bound terminal output scheduling" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Implement TerminalController attach, replay suppression, input gating, and presentation caps

**Files:**
- Create: `C:\Dev\TermX\ui\src\terminal\TerminalController.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\TerminalController.test.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\presentationLimit.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\presentationLimit.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\FakeTerminal.ts`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`

**Interfaces:**
- Consumes: `HostClient`, `OutputWriteQueue`, `reconcileOffset`, `TerminalFactory`.
- Produces:
  ```ts
  export type TerminalResyncReason =
    | 'live_gap'
    | 'live_backlog_overflow'
    | 'replay_protocol_violation'
    | 'connection_generation_changed'
    | 'session_closed';

  export type SafeTerminalErrorCode =
    | 'attachment_unknown'
    | 'host_rejected'
    | 'output_overflow'
    | 'replay_invalid'
    | 'input_encoding_invalid'
    | 'presentation_invariant'
    | 'operation_aborted'
    | 'terminal_internal';

  export interface SafeTerminalError {
    readonly code: SafeTerminalErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  }

  export class TerminalInputEncodingError extends Error {
    override readonly name = 'TerminalInputEncodingError';
    constructor(readonly reasonCode: 'non_byte_code_unit') {
      super('terminal binary callback contained a non-byte code unit');
    }
  }

  export type InitialReplayMode = 'replay' | 'skip';

  export interface TerminalSwitchOptions {
    readonly initialReplayMode?: InitialReplayMode;
  }

  export type TerminalControllerState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'detaching'; readonly sessionId: number; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration }
    | { readonly kind: 'creating'; readonly sessionId: number; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration }
    | { readonly kind: 'attaching'; readonly sessionId: number; readonly requestId: RequestId; readonly replayMode: InitialReplayMode; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration }
    | { readonly kind: 'replaying'; readonly sessionId: number; readonly requestId: RequestId | null; readonly replayId: ReplayId | null; readonly replayMode: InitialReplayMode; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration; readonly attachedAcknowledged: boolean; readonly replayDrained: boolean; readonly nextOffset: bigint }
    | { readonly kind: 'active'; readonly sessionId: number; readonly nextOffset: bigint; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration }
    | { readonly kind: 'resynchronizing'; readonly sessionId: number; readonly reason: TerminalResyncReason; readonly switchGeneration: number; readonly connectionGeneration: ConnectionGeneration }
    | { readonly kind: 'failed'; readonly sessionId: number | null; readonly error: SafeTerminalError };

  export interface TerminalControllerOptions {
    readonly client: HostClient;
    readonly terminalFactory: TerminalFactory;
    readonly terminalOptions: TerminalFactoryOptions;
    readonly decodeBase64Into: typeof decodeReplayBase64Into;
    readonly getSession: (
      sessionId: number,
    ) => SessionInfoV2 | null;
    readonly onRendererStatus: (
      status: TerminalRendererStatus,
    ) => void;
  }

  export interface TerminalControllerMetrics {
    readonly encodedReplayItemCount: number;
    readonly encodedReplayUtf8Bytes: number;
    readonly decodedReplayItemCount: number;
    readonly liveItemCount: number;
    readonly totalDecodedItemCount: number;
    readonly replayBytes: number;
    readonly liveBytes: number;
    readonly scratchBytes: 524_288;
    readonly pendingDecodedBytes: number;
    readonly activeWriteCallbackCount: number;
    readonly estimatedPresentationBytes: number;
    readonly writeCountSinceMeasurement: number;
    readonly forwardedInputFrames: number;
    readonly suppressedReplyCount: number;
  }

  export class TerminalController {
    constructor(options: TerminalControllerOptions);
    mount(element: HTMLElement): void;
    switchSession(
      sessionId: number,
      options?: TerminalSwitchOptions,
    ): Promise<void>;
    fitAndResize(): Promise<TerminalDimensions>;
    focus(): void;
    resize(cols: number, rows: number): Promise<void>;
    detach(): Promise<void>;
    state(): TerminalControllerState;
    metrics(): TerminalControllerMetrics;
    dispose(): void;
  }

  export class ReplaySequenceValidator {
    beginInitial(
      requestId: RequestId,
      sessionId: number,
      mode: InitialReplayMode,
    ): void;
    beginLagged(sessionId: number, replayId: ReplayId): void;
    accept(message: ReplayChunkMessage): {
      readonly replayId: ReplayId;
      readonly startOffset: bigint;
      readonly endOffset: bigint;
      readonly finalChunk: boolean;
      readonly data: ValidatedReplayBase64;
    };
    completeAttached(message: AttachedMessage): void;
    completeLagged(): void;
    reset(): void;
  }

  export class LogicalLineLimiter {
    transform(bytes: Uint8Array): readonly PresentationWrite[];
    reset(): void;
  }

  export interface PresentationTrimDecision {
    readonly linesToKeep: number;
    readonly measuredUtf16Bytes: number;
    readonly targetUtf16Bytes: 12_582_912;
  }

  export function selectPresentationTrim(
    measurement: TerminalPresentationMeasurement,
    newestLineUtf16Bytes: readonly number[],
  ): PresentationTrimDecision | null;
  export function xtermBinaryStringToBytes(value: string): Uint8Array;
  ```
- `getSession` is the controller's injected canonical selector. `switchSession` and `resize` call it before sending: only `lifecycle:'running'|'exited'` may attach for presentation, only `lifecycle:'running'` may accept input/resize, and `closing|close_uncertain` or absence transitions to the visible resynchronizing/session-closed path without sending input or resize. The controller does not import React context or cache a second canonical session store.
- `xtermBinaryStringToBytes` lives in `TerminalController.ts`. It allocates one `Uint8Array(value.length)`, requires every UTF-16 code unit to be at most `0xff`, copies each code unit verbatim, and throws `TerminalInputEncodingError` with safe reason `non_byte_code_unit` before sending anything if any code unit is larger. It does not use `TextEncoder`, because xterm `onBinary` is already a binary byte string.
- `TerminalPort.onRendererStatus` is a state subscription, not an event-only callback: it synchronously invokes every new listener once with the adapter's cached current status before returning the `Disposable`, then emits only later changes. `XtermTerminalFactory.create` initializes that cache to `webgl`, changes it to `compatibility` if initial WebGL construction/load fails, and preserves the latest value through context loss. `TerminalController` subscribes once immediately after terminal creation, forwards only current switch/connection-generation statuses through `TerminalControllerOptions.onRendererStatus`, disposes the subscription with that terminal, and ignores stale terminal statuses. Therefore an initialization failure occurring inside `create` cannot be lost before controller subscription.
- `TerminalController.fitAndResize()` calls the current terminal's public `fit()` exactly once, validates the returned integer dimensions through the same 2..1000 bounds as `resize`, and sends/coalesces `Resize` only when the current canonical session is `running`; it resolves with the measured dimensions after the resize outcome settles. Concurrent ResizeObserver notifications are last-value coalesced behind at most one correlated `Resize`. `focus()` forwards only for the current mounted terminal after a completed active attachment; otherwise it is a no-op. Neither method constructs a terminal or changes attachment ownership.
- `TerminalController.metrics()` is the sole aggregation boundary: encoded values come from `ReplayEnvelopeInbox.metrics()`, queue values come from `OutputWriteQueue.metrics()`, `scratchBytes` is the literal 524,288 controller allocation, and `pendingDecodedBytes = replayBytes + liveBytes + scratchBytes`. `estimatedPresentationBytes` is exactly `lastMeasuredPresentationUtf16Bytes + estimatedUtf16GrowthSinceMeasurement`: a successful measurement or post-trim verification replaces `lastMeasuredPresentationUtf16Bytes` with `measurement.estimatedUtf16Bytes` and resets growth to zero; every completed source or marker write adds the conservative UTF-16 byte length actually passed to xterm until the next measurement. `writeCountSinceMeasurement` resets at the same points. All fields return immutable numeric snapshots rather than exposing mutable queue/inbox internals.
- Invariant: replay-generated `onData`/`onBinary` callbacks are counted and discarded while replay writes execute; they never reach `HostClient.sendInput`.

- [ ] **Step 1: Write failing ordered-attach and suppression tests**

```ts
import { describe, expect, it } from 'vitest';
import { TerminalFixture } from '../test/fixtures';

describe('TerminalController attachment switching', () => {
  it('serializes rapid switches and waits for matching DetachAccepted before replacement Attach', async () => {
    const fixture = await TerminalFixture.active(1, 0n);
    const firstTerminal = fixture.terminal();

    const switchToTwo = fixture.controller.switchSession(2);
    expect(fixture.sentTypes()).toEqual(['Detach']);
    expect(firstTerminal.isDisposed()).toBe(false);

    const switchToThree = fixture.controller.switchSession(3);
    expect(fixture.sentTypes()).toEqual(['Detach']);

    fixture.replyDetachAccepted({ sessionId: 99 });
    expect(fixture.sentAttachSessionIds()).toEqual([]);
    expect(firstTerminal.isDisposed()).toBe(false);

    fixture.replyDetachAccepted({ sessionId: 1 });
    expect(fixture.sentAttachSessionIds()).toEqual([2]);
    expect(firstTerminal.isDisposed()).toBe(true);
    fixture.completeInitialAttach({ sessionId: 2, bytes: bytesFrom('two') });
    await switchToTwo;

    expect(fixture.sentTypes().slice(-1)).toEqual(['Detach']);
    fixture.replyDetachAccepted({ sessionId: 2 });
    expect(fixture.sentAttachSessionIds()).toEqual([2, 3]);
    fixture.completeInitialAttach({ sessionId: 3, bytes: bytesFrom('three') });
    await switchToThree;
    expect(fixture.controller.state()).toMatchObject({ kind: 'active', sessionId: 3 });
  });

  it('discards all binary until matching Attached and opens input only after replay drains', async () => {
    const fixture = await TerminalFixture.mounted();
    const switching = fixture.controller.switchSession(7);
    const requestId = fixture.lastSentRequestId('Attach');

    fixture.receiveOutput({ sessionId: 7, offset: 0n, bytes: bytesFrom('before') });
    fixture.replyReplayChunk({
      requestId,
      sessionId: 7,
      replayId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      chunkIndex: 0,
      startOffset: 0n,
      bytes: bytesFrom('history'),
      finalChunk: true,
    });
    fixture.terminal().userData('reply-produced-during-replay');
    fixture.replyAttached({
      requestId,
      sessionId: 7,
      replayId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ringStart: 0n,
      replayEnd: 7n,
      streamOffset: 7n,
    });
    fixture.receiveOutput({ sessionId: 7, offset: 7n, bytes: bytesFrom('live') });

    expect(fixture.inputFrames()).toHaveLength(0);
    expect(fixture.controller.state()).toMatchObject({
      kind: 'replaying',
      attachedAcknowledged: true,
      replayDrained: false,
    });

    fixture.terminal().completeNextWrite();
    fixture.terminal().completeNextWrite();
    await switching;
    fixture.terminal().userData('x');
    expect(fixture.decodedInputPayloads()).toEqual([bytesFrom('x')]);
    expect(fixture.terminal().writtenText()).not.toContain('before');
    expect(fixture.terminal().writtenText()).toContain('historylive');
  });

  it('invalidates and resnapshots after Detach timeout without sending replacement Attach', async () => {
    const fixture = await TerminalFixture.active(1, 0n);
    const terminal = fixture.terminal();
    const switching = fixture.controller.switchSession(2);

    fixture.clock.advanceBy(fixture.detachTimeoutMs());

    await expect(switching).rejects.toMatchObject({
      name: 'MutationOutcomeUnknownError',
      requestKind: 'Detach',
    });
    expect(fixture.sentTypes()).toEqual(['Detach']);
    expect(fixture.sentAttachSessionIds()).toEqual([]);
    expect(fixture.disconnectReasons()).toContain('resnapshot');
    expect(terminal.isDisposed()).toBe(false);
  });

  it('drops stale stream items by connection and switch generation', async () => {
    const fixture = await TerminalFixture.active(1, 0n);
    const switching = fixture.controller.switchSession(2);
    fixture.replyDetachAccepted({ sessionId: 1 });

    fixture.receiveOutput({
      connectionGeneration: fixture.oldConnectionGeneration(),
      sessionId: 2,
      offset: 0n,
      bytes: bytesFrom('old-connection'),
    });
    fixture.receiveOutputForPriorSwitch({
      sessionId: 2,
      offset: 0n,
      bytes: bytesFrom('old-switch'),
    });

    fixture.completeInitialAttach({ sessionId: 2, bytes: bytesFrom('current') });
    await switching;
    expect(fixture.terminal().writtenText()).toContain('current');
    expect(fixture.terminal().writtenText()).not.toContain('old-connection');
    expect(fixture.terminal().writtenText()).not.toContain('old-switch');
  });

  it('overflow starts one Detach and waits for its barrier before one replay Attach', async () => {
    const fixture = await TerminalFixture.active(7, 0n);
    fixture.blockWrites();
    fixture.receiveOutput({ sessionId: 7, offset: 0n, bytes: bytes(1_048_563) });
    fixture.receiveOutput({ sessionId: 7, offset: 1_048_563n, bytes: bytes(1_048_563) });
    fixture.receiveOutput({ sessionId: 7, offset: 2_097_126n, bytes: bytes(26) });
    fixture.receiveOutput({ sessionId: 7, offset: 2_097_152n, bytes: bytes(1) });
    fixture.receiveOutput({ sessionId: 7, offset: 2_097_153n, bytes: bytes(1) });

    expect(fixture.sentTypes().slice(-1)).toEqual(['Detach']);
    expect(fixture.sentAttachSessionIds()).toEqual([7]);
    expect(fixture.controller.state().kind).toBe('resynchronizing');

    fixture.replyDetachAccepted({ sessionId: 7 });
    expect(fixture.sentAttachSessionIds()).toEqual([7, 7]);
  });
});
```

`TerminalFixture` is introduced in Task 7 with public readonly `host: HostFixture`, `controller: TerminalController`, `terminals: FakeTerminalFactory`, and `clock: ManualClock`; private nullable current-terminal state; assertion getter `terminal(): FakeTerminalPort`; static `mounted(): Promise<TerminalFixture>` and `active(sessionId: number, nextOffset: bigint): Promise<TerminalFixture>`; and every helper used above: `completeInitialAttach`, `replyReplayChunk`, `replyAttached`, `replyDetachAccepted`, `receiveOutput`, `receiveOutputForPriorSwitch`, `sentTypes`, `sentAttachSessionIds`, `sentDetachSessionIds`, `lastSentRequestId`, `inputFrames`, `decodedInputPayloads`, `disconnectReasons`, `oldConnectionGeneration`, `detachTimeoutMs`, and `blockWrites`. The getter resolves `terminals.current()` and throws a test-setup error when no live terminal exists, so a mounted fixture cannot hold a stale terminal after A-to-B switching. Tests call `fixture.terminal()` rather than reading a readonly field. Task 8 extends this same fixture with private nullable component render state, assertion getter `renderResult(): RenderResult`, instance `rerender`/`completeSwitch`, and static `renderView(...): Promise<RenderedTerminalFixture>`, where `RenderedTerminalFixture` is the narrowed fixture type returned only after both current terminal and render-result assertions pass. `completeInitialAttach` emits a valid request-correlated sequence selected by an exact options union: `{ mode:'replay'; sessionId; chunks: readonly Uint8Array[] } | { mode:'empty_replay'; sessionId } | { mode:'skip'; sessionId }`; it emits matching `Attached`, completes each fake xterm write callback in physical order, and never bypasses `ReplaySequenceValidator`. The shorthand `{ sessionId, bytes }` used in the tests above is a typed alias for one non-empty replay chunk and is normalized by the fixture before emission.

Add separate RED cases for subscribe-before-Detach/Attach ordering; wrong request-ID/session `DetachAccepted` causing immediate `invalid_frame` disconnect rather than leaving a request pending; current attaching/replaying attachment teardown; old queue abort/unsubscribe; no old terminal/addon/listener disposal before the barrier; Detach structured error and timeout; no replacement terminal or Attach after either failure; RIS-lite reset before Attach; and all four initial modes: (1) `replay` with non-empty multi-chunk sequence, (2) `replay` with an empty interval and zero chunks, (3) `skip`/wire `replay:false` with zero chunks, and (4) each zero-chunk mode rejecting any chunk or present `Attached.replay_id`. Freeze absent wire `replay_id` as the sole no-replay encoding; explicit JSON `null` rejects in Task 2 before domain projection to `replayId:null`. Cover initial request-ID equality; chunk index zero/plus-one; deterministic valid replay UUID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`; stable replay ID; exact offset continuity; decoded length equals interval; one final chunk/no post-final chunks; matching `Attached.replay_id/replay_end/stream_offset`; lagged `request_id:null` with fresh replay UUID and no second `Attached`; an earlier eligible live continuation writing before later lagged replay; an earlier forward-gap live item staying blocked until replay fills/advances the interval; post-replay drop/trim/write/detach re-evaluation; full duplicate drop; partial overlap trim; ring-eviction marker; unexplained live-gap single-flight reattach; replay-ID change rejection; one 512 KiB decode scratch followed by one queue-owned copy; source-buffer mutation after enqueue; 240 KiB input chunking; xterm binary-string code-unit rejection above 255 and exact byte conversion; resize validation/coalescing; dead/closing-session rejection; 256 KiB logical-line marker; source-byte accumulation forcing measurement before the next write could exceed the 256 KiB interval; every 100 completed writes as a backstop; 16 MiB crossing trimmed toward 12 MiB; generated markers not advancing source offsets; A-to-B-to-A serialization; 4,096 live-item cap; one active callback; and exact encoded/decoded metrics caps.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/terminal/TerminalController.test.ts src/terminal/presentationLimit.test.ts
```

Expected: controller, line limiter, and presentation measurement do not exist.

- [ ] **Step 3: Implement the generation-scoped attach state machine**

Serialize every `switchSession`, explicit `detach`, overflow recovery, and live-gap resynchronization through one controller-owned promise chain. `switchSession` defaults `initialReplayMode` to `'replay'`; tests may pass `{ initialReplayMode:'skip' }`, which maps to exact wire `replay:false`. At the start of each operation increment and capture local `switchGeneration`, capture the current HostClient `connectionGeneration`, and close the input gate. Every subscription callback, xterm write callback, request continuation, and queued item compares both captured generations with the current controller/client generations; stale work returns without writing, advancing offsets, releasing current accounting, or opening input.

Abort the old `OutputWriteQueue`, synchronously dispose its stream subscriptions, and suppress further old input callbacks. If any current attachment exists for this controller in attaching, replaying, or active state, transition to `detaching`, send exactly one HostClient-generated correlated `Detach`, and await the matching `DetachAccepted` before disposing the old terminal/addons/listeners or sending a replacement `Attach`. A wrong request ID/session/type does not release the barrier. A structured Detach error or timeout calls `client.disconnect('resnapshot')`, leaves the old presentation intact until connection-invalidation cleanup owns it, rejects the switch, and sends neither a replacement terminal nor `Attach`; HostProvider alone schedules reconnect/bootstrap/snapshot. If no current attachment exists, skip Detach.

Only after the Detach barrier succeeds, dispose the old terminal/addons/listeners; transition to `creating`; create and open exactly one new terminal; install `onData`/`onBinary`; call `reset()` and write `[!p`; clear controller counters and pending presentation work; and subscribe to stream/state notifications before calling `client.requestTracked({ type:'Attach', sessionId, replay: initialReplayMode === 'replay' })`. Pass the returned request ID and exact mode to `ReplaySequenceValidator.beginInitial` before any replay item can be reduced. The host requirement frozen in Phase 2 aborts/awaits the prior forwarder and passes an ordered physical-writer barrier before replay/`Attached`, so no old-forwarder binary can cross the new correlated `Attached`; no wire attachment-generation field is added.

Before the matching correlated `Attached`, discard every binary output rather than queueing or reconciling it. Validate initial replay request ID, session, replay ID, chunk index, final-chunk uniqueness, decoded length, and offset continuity while draining one chunk at a time. Once matching `Attached` is observed, set `attachedAcknowledged=true`; binary physically after that envelope may enter the bounded live queue, but it remains behind replay writes until `replayDrained=true`. Transition to active and open input only when both flags are true and `nextOffset === Attached.streamOffset`. During every replay write, increment `replySuppressionDepth` before `terminal.write` and decrement it only through the settle-once write callback. `onData` and `onBinary` discard while suppression depth is nonzero or input is closed.

```ts
private forwardUserBytes(bytes: Uint8Array): void {
  if (!this.inputGateOpen || this.stateValue.kind !== 'active') return;
  for (let offset = 0; offset < bytes.byteLength; offset += 240 * 1024) {
    this.client.sendInput(
      this.stateValue.sessionId,
      bytes.slice(offset, Math.min(offset + 240 * 1024, bytes.byteLength)),
    );
    this.forwardedInputFrames += 1;
  }
}
```

`LogicalLineLimiter` counts authoritative source bytes between LF bytes. At 256 KiB without LF it outputs the bytes through the boundary, inserts `\r\n[TermX: logical line hard-wrapped at 256 KiB]\r\n`, resets the per-line count, and continues without changing the authoritative source offset.

Maintain `estimatedUtf16GrowthSinceMeasurement` in the same units as the presentation cap. Before admitting each source write, conservatively reserve `2 * sourceByteLength` estimated UTF-16 bytes; before admitting a marker, reserve `marker.length * 2`. If that reservation would make unmeasured growth exceed 262,144 bytes, measure before the write, reset the growth counter from the observed baseline, and then admit it. Independently, every 100 completed writes is a mandatory backstop measurement even when the growth threshold has not fired. After each measurement, reset both `estimatedUtf16GrowthSinceMeasurement` and `writeCountSinceMeasurement` to zero. This freezes the specification's “one 256 KiB measurement interval” as at most 262,144 conservatively estimated UTF-16 bytes, not 262,144 raw source bytes.

The production adapter iterates only public `terminal.buffer.active` lines from index `0` through `length - 1`, obtains each existing line with `getLine(i)`, calls `translateToString(true)` once, and records `text.length * 2` UTF-16 bytes plus a two-byte logical newline for every non-final line. It returns total lines, viewport rows, total estimated bytes, and per-line byte estimates. No Serialize addon output is used as a rendered-text proxy.

If the measurement exceeds 16,777,216 bytes, `selectPresentationTrim` walks the per-line estimates from newest to oldest until the retained suffix is at or below 12,582,912 bytes, never retaining fewer than `viewportRows`. Call `terminal.trimPresentationToLines(linesToKeep)`, then enqueue the marker `[TermX: renderer scrollback trimmed; host replay remains authoritative]` as `PresentationWrite.kind='marker'`. `XtermTerminalFactory.trimPresentationToLines` uses the verified public normal-buffer option seam: save the configured line ceiling, set `terminal.options.scrollback = Math.max(0, linesToKeep - terminal.rows)` so xterm synchronously discards excess oldest normal-buffer lines, then restore `terminal.options.scrollback = Math.max(0, 10_000 - terminal.rows)`. The adapter verifies with a second `measurePresentation()` that total lines are at most `linesToKeep`; failure is a terminal presentation invariant violation that invalidates the renderer attachment and resnapshots rather than silently retaining unbounded content. Alternate-buffer contents are measured but not trimmed; the controller defers trimming until the normal buffer is active. The next measurement occurs before estimated presentation growth can exceed the last measured value by more than 262,144 bytes.

- [ ] **Step 4: Verify GREEN**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test -- --run src/terminal/TerminalController.test.ts src/terminal/presentationLimit.test.ts src/terminal/OutputWriteQueue.test.ts src/terminal/offsets.test.ts
```

Expected: attach ordering, suppression, offset, resync, input, and presentation caps pass; no fake terminal/listener remains live after disposal.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/terminal/TerminalController.ts ui/src/terminal/TerminalController.test.ts ui/src/terminal/presentationLimit.ts ui/src/terminal/presentationLimit.test.ts ui/src/test/FakeTerminal.ts ui/src/test/fixtures.ts
git commit -m "feat(ui): control ordered terminal replay" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Render one visible xterm with WebGL fallback and close-safe lifecycle

**Files:**
- Create: `C:\Dev\TermX\ui\src\terminal\xtermAdapter.ts`
- Create: `C:\Dev\TermX\ui\src\terminal\TerminalView.tsx`
- Create: `C:\Dev\TermX\ui\src\terminal\TerminalView.test.tsx`
- Modify: `C:\Dev\TermX\ui\src\app\App.tsx`
- Modify: `C:\Dev\TermX\ui\src\app\styles.css`
- Modify: `C:\Dev\TermX\ui\src\test\FakeTerminal.ts`

**Interfaces:**
- Consumes: `useHost`, canonical session selectors, `TerminalController`.
- Produces:
  ```ts
  export type XtermFactoryOptions = TerminalFactoryOptions;

  export class TerminalPresentationInvariantError extends Error {
    override readonly name = 'TerminalPresentationInvariantError';
    constructor(
      readonly reasonCode:
        | 'alternate_buffer_not_trimmable'
        | 'trim_postcondition_failed',
    ) {
      super(`terminal presentation invariant failed: ${reasonCode}`);
    }
  }

  export class XtermTerminalFactory implements TerminalFactory {
    create(options: TerminalFactoryOptions): TerminalPort;
  }

  export interface TerminalViewStatus {
    readonly renderer: TerminalRendererStatus;
    readonly operationError: SafeTerminalError | null;
  }

  export interface TerminalViewProps {
    readonly sessionId: number | null;
  }

  export function TerminalView(props: TerminalViewProps): JSX.Element;
  ```
- Invariant: WebGL addon failure/context loss disposes only the addon and records visible renderer fallback; it does not detach, reattach, resize, close, or restart the host session.

- [ ] **Step 1: Write failing component lifecycle/fallback tests**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TerminalView } from './TerminalView';
import { TerminalFixture } from '../test/fixtures';

 describe('TerminalView', () => {
  it('keeps exactly one terminal alive across tab switches', async () => {
    const fixture = await TerminalFixture.renderView({ sessionId: 1 });
    fixture.rerender(<TerminalView sessionId={2} />);
    await fixture.completeSwitch(2);
    expect(fixture.terminals.liveCount()).toBe(1);
    expect(fixture.sentAttachSessionIds()).toEqual([1, 2]);
    expect(fixture.sentDetachSessionIds()).toEqual([1]);
  });

  it('falls back when WebGL initialization fails without reattaching', async () => {
    const fixture = await TerminalFixture.renderView({ sessionId: 1, webglLoadFails: true });
    expect(await screen.findByText(/compatibility renderer/i)).toBeVisible();
    expect(fixture.sentAttachSessionIds()).toEqual([1]);
    expect(fixture.sentDetachSessionIds()).toEqual([]);
  });

  it('unmount disposes renderer resources but sends no CloseSession', async () => {
    const fixture = await TerminalFixture.renderView({ sessionId: 1 });
    fixture.renderResult().unmount();
    expect(fixture.terminals.liveCount()).toBe(0);
    expect(fixture.sentTypes()).not.toContain('CloseSession');
    expect(fixture.sentTypes()).not.toContain('Shutdown');
  });
});
```

Add context-loss fallback, resize-observer cleanup, inactive/dead/closing/close-uncertain presentation, focus restoration after attach, selected-session removal, host disconnect disposal, and no hidden second terminal tests. Add one ref-freshness test that renders a running session, constructs exactly one `TerminalController`, installs a later canonical snapshot changing that same session to `closing`, invokes the controller's injected `getSession` through a resize or input attempt, and proves it observes `closing`, sends no `Resize` or input frame, and does not reconstruct the controller. This test must fail if `getSession` closes over the render-time `host.store` value rather than reading `hostStoreRef.current`.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/terminal/TerminalView.test.tsx
```

Expected: xterm adapter and component do not exist.

- [ ] **Step 3: Implement the production xterm adapter and React lifecycle**

`XtermTerminalFactory` constructs `Terminal` with the complete caller-supplied options and enforces `scrollback = Math.max(0, 10_000 - rows)`, loads the Fit addon, subscribes to `WebglAddon.onContextLoss` before `terminal.loadAddon(webgl)`, and then attempts WebGL once. On load/context failure it disposes only WebGL, keeps the base terminal open, and reports compatibility rendering through `TerminalPort`; it does not detach, reattach, resize, close, or restart the host session.

`measurePresentation` uses only public `terminal.buffer.active.length`, `getLine(i)`, `translateToString(true)`, `terminal.rows`, and `terminal.buffer.active.type`. `trimPresentationToLines` accepts only a normal active buffer and uses the public `terminal.options.scrollback` setter: lower it to `Math.max(0, linesToKeep - terminal.rows)`, verify that the public buffer length contracted, and restore `Math.max(0, 10_000 - terminal.rows)`. It throws rather than claiming success if the active buffer is alternate or the postcondition fails. It never calls private xterm internals or uses Serialize output for rendered-text measurement.

`TerminalView` owns one controller in a ref. The construction effect depends on both `host.client` and its branded `connectionGeneration`; any replacement synchronously disposes the old controller/subscriptions/terminal and creates one new controller with all required options: `{ rows: bounded session rows or 24, cols: bounded session cols or 80, scrollback: Math.max(0, 10_000 - rows) }` plus `decodeReplayBase64Into`. The selection effect calls an owned `runControllerOperation` helper that awaits `switchSession`/`detach`, ignores only disposal-driven `AbortError`, converts every other rejection to `SafeTerminalError`, stores it in visible React state, and never uses an unobserved `void` Promise. A compatibility status subscription updates a visible `role="status"` element independently of operation errors. It never calls `CloseSession`. A `ResizeObserver` invokes Fit, reads bounded columns/rows, and awaits/coalesces `Resize` only when the active session is running and dimensions changed; resize rejection is surfaced through the same visible operation-error state.

```tsx
export function TerminalView({ sessionId }: TerminalViewProps): JSX.Element {
  const host = useHost();
  const session = useSession(sessionId);
  const elementRef = React.useRef<HTMLDivElement>(null);
  const controllerRef = React.useRef<TerminalController | null>(null);
  const operationGenerationRef = React.useRef(0);
  const hostStoreRef = React.useRef(host.store);
  hostStoreRef.current = host.store;
  const [status, setStatus] = React.useState<TerminalViewStatus>({
    renderer: 'webgl',
    operationError: null,
  });

  React.useEffect(() => {
    if (!host.client || !elementRef.current) return;
    const rows = session?.rows ?? 24;
    const cols = session?.cols ?? 80;
    const controller = new TerminalController({
      client: host.client,
      terminalFactory: new XtermTerminalFactory(),
      terminalOptions: {
        rows,
        cols,
        scrollback: Math.max(0, 10_000 - rows),
      },
      decodeBase64Into: decodeReplayBase64Into,
      getSession: candidateSessionId =>
        hostStoreRef.current.canonical?.sessions.get(
          candidateSessionId,
        ) ?? null,
      onRendererStatus: renderer => {
        setStatus(current => ({ ...current, renderer }));
      },
    });
    controller.mount(elementRef.current);
    controllerRef.current = controller;
    const operationGeneration = ++operationGenerationRef.current;
    return () => {
      operationGenerationRef.current = operationGeneration + 1;
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [host.client, host.connectionGeneration]);

  React.useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const operationGeneration = ++operationGenerationRef.current;
    const operation = session?.lifecycle === 'running' || session?.lifecycle === 'exited'
      ? controller.switchSession(session.sessionId)
      : controller.detach();
    operation.catch((error: unknown) => {
      if (operationGeneration !== operationGenerationRef.current || isAbortError(error)) return;
      setStatus(current => ({ ...current, operationError: toSafeTerminalError(error) }));
    });
  }, [session?.sessionId, session?.lifecycle, host.connectionGeneration]);

  return (
    <section className="terminal-shell">
      {status.renderer === 'compatibility' && (
        <div role="status">Compatibility renderer active</div>
      )}
      {status.operationError && (
        <div role="alert">{status.operationError.message}</div>
      )}
      <div className="terminal-view" ref={elementRef} data-session-id={sessionId ?? undefined} />
    </section>
  );
}
```

`HostContextValue` exposes `connectionGeneration: ConnectionGeneration | null`; it is updated atomically with `client`. The controller owns `TerminalPort.onRendererStatus` subscription/disposal and reports current-generation statuses through the required `onRendererStatus` option shown above; `TerminalView` stores that safe enum directly.

`isAbortError` and `toSafeTerminalError` are private functions in `TerminalView.tsx`; disposal creates its abort through `new DOMException('terminal controller disposed', 'AbortError')`. Their complete implementation is:

```ts
function isAbortError(value: unknown): value is DOMException {
  return typeof value === 'object' && value !== null &&
    'name' in value && value.name === 'AbortError';
}

function toSafeTerminalError(error: unknown): SafeTerminalError {
  if (error instanceof MutationOutcomeUnknownError) {
    return {
      code: 'attachment_unknown',
      message: 'Terminal attachment outcome is unknown; reconnecting.',
      retryable: true,
    };
  }
  if (error instanceof HostError) {
    return {
      code: 'host_rejected',
      message: error.response.message,
      retryable: error.response.retryable,
    };
  }
  if (
    error instanceof OutputQueueOverflowError ||
    error instanceof ReplayEnvelopeOverflowError
  ) {
    return {
      code: 'output_overflow',
      message: 'Terminal output exceeded the renderer backlog limit; reconnecting.',
      retryable: true,
    };
  }
  if (
    error instanceof ReplayEnvelopeProtocolError ||
    error instanceof ProtocolValidationError
  ) {
    return {
      code: 'replay_invalid',
      message: 'Terminal replay was invalid; reconnecting.',
      retryable: true,
    };
  }
  if (error instanceof TerminalInputEncodingError) {
    return {
      code: 'input_encoding_invalid',
      message: 'Terminal input encoding was invalid.',
      retryable: false,
    };
  }
  if (error instanceof TerminalPresentationInvariantError) {
    return {
      code: 'presentation_invariant',
      message: 'Terminal presentation could not be bounded safely; reconnecting.',
      retryable: true,
    };
  }
  if (isAbortError(error)) {
    return {
      code: 'operation_aborted',
      message: 'Terminal operation was cancelled.',
      retryable: true,
    };
  }
  return {
    code: 'terminal_internal',
    message: 'The terminal renderer encountered an internal error.',
    retryable: true,
  };
}
```

The `HostError` message is already bounded and safe because Task 2's protocol schema enforces the 1,024-byte server-message limit. The mapper never returns an unknown error's message, stack, source bytes, request payloads, or arbitrary `String(error)`.

- [ ] **Step 4: Verify GREEN and the complete frontend suite**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test
npm --prefix ui run build
```

Expected: typecheck, zero-warning lint, all Vitest/component tests, and Vite production build pass.

- [ ] **Step 5: Commit**

```powershell
Set-Location C:\Dev\TermX
git add -- ui/src/terminal/xtermAdapter.ts ui/src/terminal/TerminalView.tsx ui/src/terminal/TerminalView.test.tsx ui/src/app/App.tsx ui/src/app/styles.css ui/src/test/FakeTerminal.ts
git commit -m "feat(ui): render one resilient xterm" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Close the Phase 6 renderer-safety gate

**Files:**
- Create: `C:\Dev\TermX\ui\src\integration\rendererSafety.test.tsx`
- Create: `C:\Dev\TermX\ui\src\integration\terminalBounds.test.ts`
- Modify: `C:\Dev\TermX\ui\src\test\fixtures.ts`
- Modify: `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-master.md`
- Modify: `C:\Dev\TermX\specs\handoffs\001-2026-07-17-termx-m1-host-core.md`
- Modify: `C:\Dev\TermX\specs\handoffs\INDEX.md`

**Interfaces:**
- Consumes: Tasks 1-8 and Phase 2 protocol fixture server where a real loopback integration is available without touching the locked default executable.
- Produces: one reviewed Phase 6 gate proving renderer lifecycle is non-destructive, canonical reduction is snapshot/event-only, replay replies cannot enter PTY input, and every renderer-owned queue has an enforced metric cap.
- `RendererSafetyFixture` is introduced only in Task 9. It exposes static `firstLaunch(): Promise<RendererSafetyFixture>` and `activeTerminal(): Promise<RendererSafetyFixture>` plus `attach`, `unmountRenderer`, `hostProduce`, `remountRenderer`, `reattach`, `visibleTerminalText`, `sentTypes`, `runBoundedReplayAndLivePressure`, and `metrics(): TerminalControllerMetrics`. It composes the real codec/reducer/provider/controller and one persistent fake host endpoint whose output ring survives renderer unmount; only the WebSocket endpoint and `TerminalPort` are fake. `metrics()` returns the controller's exact aggregate metric object without recomputing or renaming fields in test support.
- Invariant: packaged real-window/process/memory proof remains Phase 8; this task must not claim that jsdom proves a desktop render or real host survival.

- [ ] **Step 1: Write failing integrated safety tests**

```tsx
import { describe, expect, it } from 'vitest';
import { RendererSafetyFixture } from '../test/fixtures';

 describe('Phase 6 renderer safety gate', () => {
  it('relaunches from a fresh snapshot and replays output without recovery actions', async () => {
    const fixture = await RendererSafetyFixture.firstLaunch();
    await fixture.attach(7);
    fixture.unmountRenderer();
    fixture.hostProduce('marker-written-while-ui-absent');
    await fixture.remountRenderer();
    await fixture.reattach(7);
    expect(fixture.visibleTerminalText()).toContain('marker-written-while-ui-absent');
    expect(fixture.sentTypes()).not.toContain('StartRecoveryProvider');
    expect(fixture.sentTypes()).not.toContain('SubmitRecoveryInput');
    expect(fixture.sentTypes()).not.toContain('Shutdown');
  });

  it('never exceeds renderer queue and presentation metrics', async () => {
    const fixture = await RendererSafetyFixture.activeTerminal();
    await fixture.runBoundedReplayAndLivePressure();
    const metrics = fixture.metrics();
    expect(metrics.pendingDecodedBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(metrics.liveBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(metrics.replayBytes).toBeLessThanOrEqual(512 * 1024);
    expect(metrics.estimatedPresentationBytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 256 * 1024);
  });
});
```

Add integrated cases for `ReplayChunk -> Attached -> binary`, replay false, reply suppression using a DA/DSR-producing fixture, duplicate/overlap, ring eviction, forward gap, queue overflow, WebGL fallback, UI unmount/remount, malformed frame resnapshot, and protocol-major mismatch with no shutdown/restart invoke.

- [ ] **Step 2: Run RED**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui run test -- --run src/integration/rendererSafety.test.tsx src/integration/terminalBounds.test.ts
```

Expected: integrated fixtures/gate tests do not exist.

- [ ] **Step 3: Add only integrated fixtures, exact metrics assertions, and gate documentation**

Use the real TypeScript codec, reducer, HostProvider, controller, queue, and terminal adapter port in every integrated test. Fake only the transport endpoint and terminal rendering boundary. Record every sent request/frame and fail if teardown contains `CloseSession`, recovery-provider actions, continuation, native confirmation, or `Shutdown` unless a test explicitly initiated that user action; no Phase 6 test initiates one.

Update the master plan Phase 6 gate to name the exact commands below and state that Phase 7 may consume only the reviewed exported interfaces. Append the Phase 6 plan identity/status to the living handoff and update the handoff index newest row without removing prior history.

- [ ] **Step 4: Run the complete Phase 6 gate**

```powershell
Set-Location C:\Dev\TermX
npm --prefix ui ci
npm --prefix ui run typecheck
npm --prefix ui run lint
npm --prefix ui run test
npm --prefix ui run build
$env:CARGO_TARGET_DIR = Join-Path $PWD 'target-m2'
cargo test -p termx-contracts --test schema_validation
cargo test -p termx-host --test protocol_v2 --test event_sequence --test attach_replay_v2 --test protocol_bounds
cargo clippy -p termx-ui-native --all-targets --all-features -- -D warnings
git diff --check -- docs/superpowers/plans/2026-07-19-termx-m2-phase-6-react-transport-terminal.md docs/superpowers/plans/2026-07-19-termx-m2-master.md specs/handoffs/001-2026-07-17-termx-m1-host-core.md specs/handoffs/INDEX.md ui
```

Expected: dependency integrity, typecheck, zero-warning lint, all frontend tests/build, cross-language schema fixtures, host protocol/event/attach tests, native Clippy, and scoped whitespace checks pass. No command targets `C:\Dev\TermX\target\debug\termx-host.exe`.

- [ ] **Step 5: Submit exact Phase 6 bytes to Fable and commit only after approval**

Provide Fable the SHA-256, UTF-8 byte count, line count, balanced Markdown-fence count, and exact contents/diff of:

```text
C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-6-react-transport-terminal.md
```

Require Fable to verify protocol completeness, strict parsing, bigint boundaries, request accounting, snapshot/event semantics, reconnect safety, attach ordering, replay reply suppression, byte/presentation caps, xterm lifecycle, and Phase 1-5 interface compatibility. Apply every confirmed finding and resubmit the new exact bytes until Fable explicitly approves the current SHA.

After exact-current approval:

```powershell
Set-Location C:\Dev\TermX
git add -- ui docs/superpowers/plans/2026-07-19-termx-m2-phase-6-react-transport-terminal.md docs/superpowers/plans/2026-07-19-termx-m2-master.md specs/handoffs/001-2026-07-17-termx-m1-host-core.md specs/handoffs/INDEX.md
git commit -m "feat(ui): complete the M2 terminal transport" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Phase 6 Acceptance Map

| Specification requirement | Primary task and proof |
|---|---|
| React owns direct authenticated loopback WebSocket | Task 3 `HostClient`; Task 5 provider trace contains only native bootstrap plus direct socket frames |
| Closed protocol-v2 runtime validation and decimal strings to `bigint` | Task 2 strict/fixture tests |
| 4 MiB State/AuthOk, 1 MiB Sessions, 512 KiB decoded replay boundaries | Task 2 exact-byte boundary tests |
| Pending request cap 1,024 entries/2 MiB and unknown mutation reconciliation | Task 3 cap/timeout tests |
| Canonical state changes only from snapshot/events | Task 4 action union and event tests |
| Snapshot/cursor race has no loss/double reduction | Tasks 4-5 buffered event tests |
| Gap, host change, invalid frame, or slow/overflowed consumer resnapshots | Tasks 3-5 disconnect/resnapshot tests |
| Capped exponential reconnect with jitter targeting the verified host | Task 5 deterministic policy tests |
| UI crash/reload is reattach-only and launches/resumes nothing | Tasks 5 and 9 unmount/remount traces |
| Live protocol mismatch leaves host/sessions untouched and never auto-restarts | Tasks 3, 5, and 9 mismatch traces |
| `ReplayChunk -> Attached -> binary`; replay false has no initial chunk | Tasks 3, 7, and 9 ordering tests |
| Replay-generated terminal replies never reach PTY input | Tasks 7 and 9 suppression tests |
| Duplicate/partial overlap/exact continuation | Task 6 interval tests; Task 9 integration |
| Ring eviction shows truncation and advances | Tasks 6-7 marker tests |
| Live gap and queue overflow detach/reattach boundedly | Tasks 6-7 resync tests |
| One visible xterm; inactive host sessions remain alive | Task 8 lifecycle tests |
| WebGL failure/context loss leaves terminal functional | Task 8 fallback tests |
| 2 MiB live, one 512 KiB replay, one 512 KiB scratch, 3 MiB total decoded pending | Tasks 6-7 metrics tests |
| 10,000 lines, 16 MiB plus one 256 KiB interval, trim toward 12 MiB | Tasks 7-9 presentation tests |
| Input/paste chunks at most 240 KiB | Task 7 input tests |
| Dead dismissal waits for canonical `SessionClosed` | Phase 7 owns the user action; Task 4 already proves canonical close removal semantics |
| Create/type/resize/rename/recolor/group/reorder/duplicate/close/reopen | Phase 6 proves type/resize transport and terminal interaction; Phase 7 owns layout/sidebar actions and durable reopen UX |
| Closing or killing UI leaves host/shell alive; relaunch replays absent output | Task 9 renderer trace; Phase 8 owns real packaged process proof |
| Memory soak thresholds and two consecutive 30-minute runs | Phase 8 owns real process sampling; Tasks 3, 6, 7 expose exact required metrics |

Do not begin `C:\Dev\TermX\docs\superpowers\plans\2026-07-19-termx-m2-phase-7-desktop-ux-recovery.md` implementation until Fable approves the exact Phase 6 plan and, during execution, Fable approves the exact Phase 6 implementation diff.
