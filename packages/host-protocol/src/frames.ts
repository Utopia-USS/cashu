// Frames on the host socket: a 4-byte big-endian body length, then the body (UTF-8 JSON, decoded by
// the transport). A frame over the cap (16 MB; larger payloads such as statement files are chunked by
// their method) is refused as soon as its header arrives, before its body is buffered; the transport
// then closes the connection. Pure byte handling, so the same reader serves every runtime.

/** Largest frame body accepted or sent. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 4;

export type FrameErrorReason = "oversize" | "invalid-text" | "invalid-json" | "invalid-message";

/** A frame that cannot be accepted. The connection that sent it is closed. */
export class FrameError extends Error {
  readonly reason: FrameErrorReason;

  constructor(reason: FrameErrorReason, message: string) {
    super(message);
    this.name = "FrameError";
    this.reason = reason;
  }
}

/** Header + body of one frame. Throws `FrameError("oversize")` for a body over `max`. */
export function encodeFrame(body: Uint8Array, max = MAX_FRAME_BYTES): Uint8Array {
  if (body.length > max) {
    throw new FrameError("oversize", `frame of ${body.length} bytes exceeds ${max}`);
  }
  const out = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, HEADER_BYTES);
  return out;
}

/**
 * Reassembles frame bodies from stream chunks of any size. Chunks are kept as a list and copied once
 * per frame, so a large frame arriving in many chunks costs linear time.
 */
export class FrameReader {
  readonly #max: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #need: number | undefined;

  constructor(max = MAX_FRAME_BYTES) {
    this.#max = max;
  }

  /** Bytes received but not yet returned as a frame. */
  get buffered(): number {
    return this.#buffered;
  }

  /** Adds a chunk; returns every body it completed, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.#need === undefined) {
        if (this.#buffered < HEADER_BYTES) break;
        const header = this.#take(HEADER_BYTES);
        const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(
          0,
          false,
        );
        if (length > this.#max) {
          throw new FrameError("oversize", `frame of ${length} bytes exceeds ${this.#max}`);
        }
        this.#need = length;
      }
      if (this.#buffered < this.#need) break;
      out.push(this.#take(this.#need));
      this.#need = undefined;
    }
    return out;
  }

  /** Removes the first `n` buffered bytes (n <= buffered) as one array. */
  #take(n: number): Uint8Array {
    const first = this.#chunks[0];
    if (first !== undefined && first.length >= n) {
      const head = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
      this.#buffered -= n;
      return head;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0] as Uint8Array;
      const part = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (part === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(part);
    }
    this.#buffered -= n;
    return out;
  }
}
