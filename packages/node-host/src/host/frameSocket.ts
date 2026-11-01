// A socket that speaks frames of JSON (@cashu/host-protocol frames: 4-byte length + UTF-8 JSON).
// Incoming bytes are reassembled by `FrameReader`; a frame over the cap, invalid UTF-8 or invalid JSON
// destroys the connection (the peer is not ours or is broken). Messages are handed on as `unknown`:
// the receiver validates them with the schema of its phase.
import type { Socket } from "node:net";
import { encodeFrame, FrameError, FrameReader, MAX_FRAME_BYTES } from "@cashu/host-protocol";

export class FrameSocket {
  readonly #socket: Socket;
  readonly #reader: FrameReader;
  readonly #max: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #onMessage: ((message: unknown) => void) | undefined;
  readonly #onClose: ((error: FrameError | undefined) => void)[] = [];
  #error: FrameError | undefined;
  #closed = false;

  constructor(socket: Socket, max = MAX_FRAME_BYTES) {
    this.#socket = socket;
    this.#max = max;
    this.#reader = new FrameReader(max);
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.#closed = true;
      for (const cb of this.#onClose.splice(0)) cb(this.#error);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** One handler at a time; messages that arrive before it is set are dropped (none can: the peer
   * waits for our reply at every handshake step). */
  onMessage(handler: (message: unknown) => void): void {
    this.#onMessage = handler;
  }

  /** Called once when the connection is gone, with the frame error that closed it, if any. */
  onClose(handler: (error: FrameError | undefined) => void): void {
    if (this.#closed) handler(this.#error);
    else this.#onClose.push(handler);
  }

  send(message: unknown): void {
    if (this.#closed || this.#socket.destroyed) return;
    this.#socket.write(encodeFrame(Buffer.from(JSON.stringify(message), "utf8"), this.#max));
  }

  /** Sends a last message, then closes after it is flushed. */
  end(message?: unknown): void {
    if (message !== undefined) this.send(message);
    this.#socket.end();
  }

  destroy(error?: FrameError): void {
    this.#error ??= error;
    this.#socket.destroy();
  }

  #receive(chunk: Buffer): void {
    if (this.#socket.destroyed) return;
    let bodies: Uint8Array[];
    try {
      bodies = this.#reader.push(chunk);
    } catch (error) {
      this.destroy(error instanceof FrameError ? error : undefined);
      return;
    }
    for (const body of bodies) {
      let message: unknown;
      try {
        message = JSON.parse(this.#decoder.decode(body));
      } catch (error) {
        const reason = error instanceof SyntaxError ? "invalid-json" : "invalid-text";
        this.destroy(
          new FrameError(reason, `frame is not ${reason === "invalid-json" ? "JSON" : "UTF-8"}`),
        );
        return;
      }
      if (this.#socket.destroyed) return;
      this.#onMessage?.(message);
    }
  }
}
