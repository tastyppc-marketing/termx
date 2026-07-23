const TAG_OUTPUT = 1;
const TAG_INPUT = 2;
const OUTPUT_HEADER_LENGTH = 13;
const INPUT_HEADER_LENGTH = 5;
const MAX_U32 = 0xffffffff;
const MAX_U64 = 0xffffffffffffffffn;

/// Host-side `session::MAX_INPUT_FRAME`: input payloads above this get a
/// host Error reply, and anything above the 1 MiB WS cap DROPS the whole
/// connection — refuse client-side so a giant paste can never kill the link.
/// Callers chunk larger pastes (the terminal layer chunks at 64 KiB).
export const MAX_INPUT_PAYLOAD = 256 * 1024;

export interface OutputFrame {
  type: "output";
  sessionId: number;
  offset: bigint;
  data: Uint8Array;
}

export interface InputFrame {
  type: "input";
  sessionId: number;
  data: Uint8Array;
}

export type BinaryFrame = OutputFrame | InputFrame;
export type BinaryData = ArrayBuffer | ArrayBufferView;

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  assertSessionId(frame.sessionId);

  if (frame.type === "output") {
    if (frame.offset < 0n || frame.offset > MAX_U64) {
      throw new RangeError("output offset must fit an unsigned 64-bit integer");
    }
    const encoded = new Uint8Array(OUTPUT_HEADER_LENGTH + frame.data.byteLength);
    const view = new DataView(encoded.buffer);
    view.setUint8(0, TAG_OUTPUT);
    view.setUint32(1, frame.sessionId, true);
    view.setBigUint64(5, frame.offset, true);
    encoded.set(frame.data, OUTPUT_HEADER_LENGTH);
    return encoded;
  }

  if (frame.data.byteLength > MAX_INPUT_PAYLOAD) {
    throw new RangeError(
      `input payload is ${frame.data.byteLength} bytes; max ${MAX_INPUT_PAYLOAD} — chunk large pastes`,
    );
  }
  const encoded = new Uint8Array(INPUT_HEADER_LENGTH + frame.data.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint8(0, TAG_INPUT);
  view.setUint32(1, frame.sessionId, true);
  encoded.set(frame.data, INPUT_HEADER_LENGTH);
  return encoded;
}

export function decodeFrame(data: BinaryData): BinaryFrame {
  const bytes = asBytes(data);
  if (bytes.byteLength === 0) {
    throw new Error("empty frame");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint8(0);
  if (tag === TAG_OUTPUT) {
    if (bytes.byteLength < OUTPUT_HEADER_LENGTH) {
      throw new Error(`output frame too short: ${bytes.byteLength} bytes`);
    }
    return {
      type: "output",
      sessionId: view.getUint32(1, true),
      offset: view.getBigUint64(5, true),
      data: bytes.slice(OUTPUT_HEADER_LENGTH),
    };
  }

  if (tag === TAG_INPUT) {
    if (bytes.byteLength < INPUT_HEADER_LENGTH) {
      throw new Error(`input frame too short: ${bytes.byteLength} bytes`);
    }
    return {
      type: "input",
      sessionId: view.getUint32(1, true),
      data: bytes.slice(INPUT_HEADER_LENGTH),
    };
  }

  throw new Error(`unknown frame tag ${tag}`);
}

function asBytes(data: BinaryData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function assertSessionId(sessionId: number) {
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > MAX_U32) {
    throw new RangeError("session id must fit an unsigned 32-bit integer");
  }
}
