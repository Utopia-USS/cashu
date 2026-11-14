// A deterministic, position-bound, NOT secure frame codec and its gate, for tests. They have the
// properties the contract checks of the real ones (S27 frames v3 via S28b, devices/gate.ts): any
// changed byte, a wrong secret, a frame moved to another position or linked to another previous
// frame fails, and the sealed bytes do not contain the plaintext. It is not encryption and the
// "signature" is a keyed checksum anyone with the secret can make: never use either outside tests.
import type { FrameCodec, FrameGate, FrameHead, FramePosition } from "../carrier.js";
import { FrameRejectedError } from "../errors.js";
import { utf8Encode } from "../runtime.js";

const MAGIC = [0x54, 0x43, 0x30, 0x33]; // "TC03"
const HEADER = MAGIC.length + 4;
const SIG = 64;
const CHAIN = 32;

function fnv1a(seed: number, bytes: Uint8Array): number {
  let h = seed >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `n` bytes of a keyed checksum over `parts` (fnv1a with one seed per 4 output bytes). */
function checksum(n: number, ...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((k, p) => k + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length + 1;
  }
  const out = new Uint8Array(n);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i += 4) view.setUint32(i, fnv1a(0x811c9dc5 + i * 0x9e3779b9, joined));
  return out;
}

function positionSeed(secret: string, at: FramePosition): number {
  const aad = utf8Encode(`${secret}|${at.vault}|${at.device}|${at.seg}|${at.offset}`);
  return fnv1a(0x811c9dc5, aad);
}

/** Position-dependent keystream (xorshift32), so equal plaintexts at different positions differ. */
function xorStream(seed: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let x = seed || 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (bytes[i] ?? 0) ^ (x & 0xff);
  }
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function chainAfter(at: FramePosition, sealed: Uint8Array, prev: Uint8Array): Uint8Array {
  const end = at.offset + 4 + sealed.length;
  return checksum(
    CHAIN,
    utf8Encode(`chain|${at.vault}|${at.device}|${at.seg}|${at.offset}|${end}`),
    prev,
    sealed.subarray(0, sealed.length - SIG),
  );
}

function headSig(secret: string, head: Omit<FrameHead, "sig">): Uint8Array {
  return checksum(
    SIG,
    utf8Encode(`sig|${secret}|${head.device}|${head.stream}|${head.seg}|${head.offset}`),
    head.chain,
  );
}

function headAt(at: FramePosition, sealed: Uint8Array, prev: Uint8Array): Omit<FrameHead, "sig"> {
  return {
    device: at.device,
    stream: at.seg === 0 ? 0 : 1,
    seg: at.seg,
    offset: at.offset + 4 + sealed.length,
    chain: chainAfter(at, sealed, prev),
  };
}

export function insecureTestCodec(secret = "contract-test-secret"): FrameCodec {
  return {
    seal(plain, at, prev) {
      const seed = positionSeed(secret, at);
      const out = new Uint8Array(HEADER + plain.length + SIG);
      out.set(MAGIC, 0);
      new DataView(out.buffer).setUint32(MAGIC.length, fnv1a(seed, plain), false);
      out.set(xorStream(seed, plain), HEADER);
      const head = headAt(at, out, prev);
      const sig = headSig(secret, head);
      out.set(sig, out.length - SIG);
      return { sealed: out, head: { ...head, sig } };
    },
    open(sealed, at, prev) {
      if (sealed.length < HEADER + SIG || MAGIC.some((b, i) => sealed[i] !== b)) {
        throw new FrameRejectedError("bad-header");
      }
      const seed = positionSeed(secret, at);
      const plain = xorStream(seed, sealed.subarray(HEADER, sealed.length - SIG));
      const sum = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint32(
        MAGIC.length,
        false,
      );
      if (fnv1a(seed, plain) !== sum) throw new FrameRejectedError("tampered");
      return { plain, head: { ...headAt(at, sealed, prev), sig: sealed.slice(-SIG) } };
    },
    link: (sealed, at, prev) => chainAfter(at, sealed, prev),
    genesis: (vault, device, stream) =>
      checksum(CHAIN, utf8Encode(`genesis|${vault}|${device}|${stream}`), u32(0)),
  };
}

/**
 * The gate of `insecureTestCodec`: a head counts when its checksum matches the secret (any writer;
 * no registry), and every verified frame's data is accepted.
 */
export function insecureTestGate(secret = "contract-test-secret"): FrameGate {
  return {
    authenticate(head) {
      const expected = headSig(secret, head);
      return head.sig.length === SIG && expected.every((b, i) => b === head.sig[i])
        ? { ok: true }
        : { ok: false, wait: false, code: "bad_head_signature" };
    },
    accept: () => ({ verdict: { ok: true }, changed: false }),
    observe() {},
    needsReplay: () => false,
    takeRebuild: () => false,
    reset() {},
  };
}
