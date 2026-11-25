import { CryptoError } from "./errors.js";

const REDACTED = "[redacted]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Secret bytes (a data key, a device secret key) behind a wrapper that never prints them:
 * `String()`, `JSON.stringify()` and `console.log` / `util.inspect` all show `[redacted]`.
 * Callers read the bytes only through `expose()`, right where a primitive needs them.
 */
export class Secret {
  #bytes: Uint8Array;
  #wiped = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get length(): number {
    return this.#bytes.length;
  }

  expose(): Uint8Array {
    if (this.#wiped) throw new CryptoError("wiped");
    return this.#bytes;
  }

  /** Overwrite the bytes with zeros; later `expose()` throws. */
  wipe(): void {
    this.#bytes.fill(0);
    this.#wiped = true;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret(${REDACTED})`;
  }
}
