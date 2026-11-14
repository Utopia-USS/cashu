// Small binary helpers shared by the frame and key-payload formats. Every variable-length field is
// length-prefixed, so two different contexts can never encode to the same bytes.

import { CryptoError } from "./errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("u32 out of range");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("u64 out of range");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

/** u32 big-endian length followed by the bytes. */
export function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concat(u32(bytes.length), bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new RangeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// btoa / atob exist on Node 16+ and Hermes, so no Buffer (Node only) is needed.
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Sequential reader over a payload; any overrun is a malformed payload, never a partial read. */
export class Reader {
  #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  take(n: number): Uint8Array {
    if (this.#at + n > this.#bytes.length) throw new CryptoError("bad_payload");
    const out = this.#bytes.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }

  u16(): number {
    const b = this.take(2);
    return new DataView(b.buffer, b.byteOffset, 2).getUint16(0);
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
  }

  lengthPrefixed(max: number): Uint8Array {
    const n = this.u32();
    if (n > max) throw new CryptoError("bad_payload");
    return this.take(n);
  }

  end(): void {
    if (this.#at !== this.#bytes.length) throw new CryptoError("bad_payload");
  }
}
