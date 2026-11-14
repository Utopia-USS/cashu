/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";

/** Deterministic byte source (mulberry32); tests never use Math.random. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 examples", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("equals node:crypto on 2000 random byte strings (block-boundary lengths included)", () => {
    const rnd = prng(20261031);
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128];
    for (let i = 0; i < 2000; i++) {
      const n = i < lengths.length ? (lengths[i] as number) : Math.floor(rnd() * 301);
      const bytes = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("hashes a string as its UTF-8 bytes", () => {
    const text = "v1\u001fref\u001fkonto\u001fZażółć 🙂";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
