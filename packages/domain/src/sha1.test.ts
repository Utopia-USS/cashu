/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha1Hex } from "./sha1.js";

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

describe("sha1Hex", () => {
  it("matches the FIPS 180-4 examples and gid.md's budget vector", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("2026-01-15|-12.50|PLN|SKLEP TESTOWY|ZAKUP TESTOWY")).toBe(
      "451a4e645c5442bf030c14db4e9674a3592a8486",
    );
    expect(sha1Hex("7|2026-01-15|-12.50|PLN|SKLEP TESTOWY|ZAKUP TESTOWY")).toBe(
      "c5dc16ae76ac3c2d48a496fa516b61d5c5e40e01",
    );
  });

  it("equals node:crypto on 2000 random byte strings (block-boundary lengths included)", () => {
    const rnd = prng(20261030);
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128];
    for (let i = 0; i < 2000; i++) {
      const n = i < lengths.length ? (lengths[i] as number) : Math.floor(rnd() * 301);
      const bytes = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
      expect(sha1Hex(bytes)).toBe(createHash("sha1").update(bytes).digest("hex"));
    }
  });

  it("hashes a string as its UTF-8 bytes", () => {
    const text = "Łódź ąę €😀";
    expect(sha1Hex(text)).toBe(createHash("sha1").update(text, "utf8").digest("hex"));
  });
});
