// Injectable HMAC-SHA256 for DET gids (S29c spec 10, decision D11). The store is platform free, so a
// native implementation (node:crypto on desktop and the sync daemon, react-native-quick-crypto on the
// phone) is injected at the app root through `StoreOptions.hmac`; the default is @noble/hashes, the
// same code on every runtime. A DET gid is a durable identity: an implementation that disagreed by a
// single bit would mint different gids for the same row and split it in two across devices. Every
// implementation is therefore checked against RFC 4231 when a store opens (`assertHmacConformance`)
// and refused if it differs. Wiring the native adapters belongs to the app scopes (S40, S41).
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** HMAC-SHA256 keyed once: `keyed(key)(message)` returns the 32-byte MAC (RFC 2104). */
export interface HmacSha256 {
  keyed(key: Uint8Array): (message: Uint8Array) => Uint8Array;
}

/** The default: @noble/hashes, the keyed state (inner and outer pads) built once and cloned per MAC. */
export const nobleHmacSha256: HmacSha256 = {
  keyed(key) {
    const state = hmac.create(sha256, key);
    return (message) => state.clone().update(message).digest();
  },
};

const repeat = (byteHex: string, n: number) => byteHex.repeat(n);
const ascii = (text: string) =>
  [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** RFC 4231 test cases 1-4, 6 and 7 (case 5 tests truncation, which DET gids never use). */
export const HMAC_VECTORS: readonly { key: string; data: string; mac: string }[] = [
  {
    key: repeat("0b", 20),
    data: ascii("Hi There"),
    mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  },
  {
    key: ascii("Jefe"),
    data: ascii("what do ya want for nothing?"),
    mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  },
  {
    key: repeat("aa", 20),
    data: repeat("dd", 50),
    mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
  },
  {
    key: "0102030405060708090a0b0c0d0e0f10111213141516171819",
    data: repeat("cd", 50),
    mac: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
  },
  {
    key: repeat("aa", 131),
    data: ascii("Test Using Larger Than Block-Size Key - Hash Key First"),
    mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  },
  {
    key: repeat("aa", 131),
    data: ascii(
      "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
    ),
    mac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
  },
];

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Thrown when an injected HMAC implementation does not reproduce RFC 4231. */
export class HmacConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HmacConformanceError";
  }
}

/**
 * Throws `HmacConformanceError` unless `impl` reproduces every RFC 4231 vector, and two MACs of one
 * keyed function stay independent (a native binding that reused its state would fail here).
 */
export function assertHmacConformance(impl: HmacSha256): void {
  for (const [i, v] of HMAC_VECTORS.entries()) {
    const mac = impl.keyed(fromHex(v.key));
    const first = toHex(mac(fromHex(v.data)));
    const second = toHex(mac(fromHex(v.data)));
    if (first !== v.mac || second !== v.mac) {
      throw new HmacConformanceError(`HMAC-SHA256 implementation fails RFC 4231 vector ${i + 1}`);
    }
  }
}
