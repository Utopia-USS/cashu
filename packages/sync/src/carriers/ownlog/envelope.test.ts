import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FrameRejectedError } from "../../errors.js";
import { utf8Encode } from "../../runtime.js";
import { seededRandom } from "../../transports/folder/testing/cloud.js";
import { decodeEnvelope, ENVELOPE_DEFLATE, ENVELOPE_STORED, encodeEnvelope } from "./envelope.js";

function deflateEnvelope(declared: number, packed: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + packed.length);
  out[0] = ENVELOPE_DEFLATE;
  new DataView(out.buffer).setUint32(1, declared, false);
  out.set(packed, 5);
  return out;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof FrameRejectedError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

const repetitive = utf8Encode(
  JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ t: "txn.imported", v: 1, n: i % 7 }))),
);

describe("frame envelope", () => {
  it("compresses a repetitive body and restores it exactly", () => {
    const env = encodeEnvelope(repetitive);
    expect(env[0]).toBe(ENVELOPE_DEFLATE);
    expect(env.length).toBeLessThan(repetitive.length / 4);
    expect(decodeEnvelope(env)).toEqual(repetitive);
  });

  it("stores short, incompressible or compression-off bodies", () => {
    const short = utf8Encode('{"f":1}');
    expect(encodeEnvelope(short)[0]).toBe(ENVELOPE_STORED);
    const random = seededRandom(7);
    const noise = Uint8Array.from({ length: 4096 }, () => Math.floor(random() * 256));
    const stored = encodeEnvelope(noise);
    expect(stored[0]).toBe(ENVELOPE_STORED);
    expect(stored.length).toBe(noise.length + 1);
    expect(decodeEnvelope(stored)).toEqual(noise);
    expect(encodeEnvelope(repetitive, { compression: false })[0]).toBe(ENVELOPE_STORED);
    expect(decodeEnvelope(encodeEnvelope(repetitive, { compression: 1 }))).toEqual(repetitive);
  });

  it("rejects an unknown codec byte as frame-format (a newer writer)", () => {
    expect(codeOf(() => decodeEnvelope(Uint8Array.of(0x07, 1, 2, 3)))).toBe("frame-format");
    expect(codeOf(() => decodeEnvelope(new Uint8Array(0)))).toBe("malformed");
  });

  it("caps the declared size and stops a zip bomb while inflating", () => {
    const bomb = deflateSync(new Uint8Array(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(16 * 1024);
    // Declares 1 KiB but inflates to 8 MiB: refused as soon as the output passes the declaration.
    expect(codeOf(() => decodeEnvelope(deflateEnvelope(1024, bomb)))).toBe("too-large");
    // Honest declaration above the reader's cap.
    expect(codeOf(() => decodeEnvelope(deflateEnvelope(8 * 1024 * 1024, bomb), 1024 * 1024))).toBe(
      "too-large",
    );
    expect(codeOf(() => decodeEnvelope(deflateEnvelope(2 ** 31, bomb)))).toBe("too-large");
    const stored = new Uint8Array(2048);
    expect(codeOf(() => decodeEnvelope(stored, 1024))).toBe("too-large");
  });

  it("rejects a declared length that does not match and a broken stream", () => {
    const packed = deflateSync(repetitive);
    expect(codeOf(() => decodeEnvelope(deflateEnvelope(repetitive.length + 1, packed)))).toBe(
      "malformed",
    );
    expect(
      codeOf(() => decodeEnvelope(deflateEnvelope(repetitive.length, packed.slice(0, 20)))),
    ).toBe("malformed");
    const garbage = Uint8Array.from({ length: 64 }, () => 0xff);
    expect(codeOf(() => decodeEnvelope(deflateEnvelope(100, garbage)))).toBe("malformed");
    expect(codeOf(() => decodeEnvelope(Uint8Array.of(ENVELOPE_DEFLATE, 0, 0)))).toBe("malformed");
  });
});
