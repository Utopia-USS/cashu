/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ibanKey, normalizeIban } from "./iban.js";
import { loadVectors, Mismatches } from "./testing/vectors.js";
import {
  isCombining,
  isPySpace,
  ND_ZEROS,
  normalizeText,
  PY_WHITESPACE,
  PY_WS,
  pyLower,
  pySplit,
  pyStrip,
  pyUpper,
  unicodeDecimal,
} from "./text.js";

/**
 * sha256 per 4096-code-point block of fn(chr(c)) joined by NUL, surrogates skipped (as vectors.py).
 * One digest input per block: the same bytes as feeding the hash per code point, without ~2 native
 * hash calls per code point (8.9M for the four functions).
 */
function blockHashes(fn: (s: string) => string): string[] {
  const out: string[] = [];
  for (let block = 0; block < 0x110000 / 4096; block++) {
    let joined = "";
    for (let c = block * 4096; c < (block + 1) * 4096; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      joined += `${fn(String.fromCodePoint(c))}\0`;
    }
    out.push(createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 16));
  }
  return out;
}

const text = loadVectors("text");
const table = (name: string) => text.rows.find((row) => row[0] === name);

describe("text vectors (parity/python/vectors.py)", () => {
  it("Unicode tables match Python", () => {
    expect(table("unicode")?.[1]).toBe(`${process.versions.unicode}.0`);
    expect(table("isspace")?.[1]).toEqual(PY_WHITESPACE);
    expect(table("re_s")?.[1]).toEqual(PY_WHITESPACE);
    const re = new RegExp(`^[${PY_WS}]$`, "u");
    const viaRegex: number[] = [];
    const combining: number[][] = [];
    for (let c = 0; c < 0x110000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (re.test(String.fromCodePoint(c))) viaRegex.push(c);
      if (isCombining(c)) {
        const last = combining[combining.length - 1];
        if (last && last[1] === c - 1) last[1] = c;
        else combining.push([c, c]);
      }
    }
    expect(viaRegex).toEqual(PY_WHITESPACE);
    expect(PY_WHITESPACE.every(isPySpace)).toBe(true);
    expect(combining).toEqual(table("combining")?.[1]);
    expect(table("nd_zeros")?.[1]).toEqual(ND_ZEROS);
    for (const zero of ND_ZEROS) {
      for (let i = 0; i < 10; i++) expect(unicodeDecimal(zero + i)).toBe(i);
    }
    expect(unicodeDecimal(0x41)).toBe(-1);
  });

  // One test per function: each is one exhaustive scan of every code point, reported on its own.
  const perCodePoint: Record<string, (s: string) => string> = {
    normalize_text: normalizeText,
    upper: pyUpper,
    lower: pyLower,
    strip: (s) => pyStrip(`x${s}x${s}`),
  };
  const blockRows = text.rows.filter((r) => r[0] === "blocks") as [string, string, string[]][];

  it("block hashes cover exactly the per-code-point functions", () => {
    expect(blockRows.map(([, name]) => name).sort()).toEqual(Object.keys(perCodePoint).sort());
  });

  for (const [, name, hashes] of blockRows) {
    it(`every code point: ${name}`, () => {
      const fn = perCodePoint[name];
      if (!fn) throw new Error(`no TS function for ${name}`);
      const m = new Mismatches();
      blockHashes(fn).forEach((hash, block) => {
        m.check(`${name} block U+${(block * 4096).toString(16)}`, hash, hashes[block]);
      });
      expect(m.checked).toBe(272);
      expect(m.items, m.report()).toEqual([]);
    });
  }

  it("strings: normalize_text, upper, lower, strip, split", () => {
    const m = new Mismatches();
    for (const row of text.rows.filter((r) => r[0] === "str")) {
      const [, s, normalized, upper, lower, stripped, joined] = row as string[];
      const label = JSON.stringify(s);
      m.check(`normalize_text ${label}`, normalizeText(s), normalized);
      m.check(`upper ${label}`, pyUpper(s as string), upper);
      m.check(`lower ${label}`, pyLower(s as string), lower);
      m.check(`strip ${label}`, pyStrip(s as string), stripped);
      m.check(`split ${label}`, pySplit(s as string).join(" "), joined);
    }
    expect(m.checked).toBeGreaterThan(20000);
    expect(normalizeText(null)).toBe(table("none")?.[1]);
    expect(normalizeText(undefined)).toBe("");
    expect(m.items, m.report()).toEqual([]);
  });

  it("IBANs: normalize_iban, iban_key", () => {
    const m = new Mismatches();
    for (const [s, normalized, key] of loadVectors("iban").rows) {
      m.check(`normalize_iban ${JSON.stringify(s)}`, normalizeIban(s as string | null), normalized);
      m.check(`iban_key ${JSON.stringify(s)}`, ibanKey(s as string | null), key);
    }
    expect(m.checked).toBeGreaterThan(6000);
    expect(m.items, m.report()).toEqual([]);
  });
});
