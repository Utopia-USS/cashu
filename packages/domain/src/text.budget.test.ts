import { describe, expect, it } from "vitest";
import { loadVectors, Mismatches } from "./testing/vectors.js";
import { ND_ZEROS, pyIsDigit, pySplitlines, pyStripChars } from "./text.js";

const vectors = loadVectors("budget-text");

describe("splitlines / strip(chars) / isdigit vectors (parity/python/vectors_budget.py)", () => {
  it("isdigit equals Python on every code point", () => {
    const digitOnly = vectors.rows.find((r) => r[0] === "isdigit_only")?.[1] as number[];
    const decimalCount = vectors.rows.find((r) => r[0] === "isdecimal_count")?.[1] as number;
    expect(ND_ZEROS.length * 10).toBe(decimalCount);
    const want = new Set(digitOnly);
    for (const zero of ND_ZEROS) for (let i = 0; i < 10; i++) want.add(zero + i);
    const got: number[] = [];
    for (let c = 0; c < 0x110000; c++) if (pyIsDigit(c)) got.push(c);
    expect(got).toEqual([...want].sort((a, b) => a - b));
  });

  it("splitlines and strip(chars) equal Python", () => {
    const m = new Mismatches();
    for (const row of vectors.rows) {
      if (row[0] === "splitlines")
        m.check(`splitlines ${row[1]}`, pySplitlines(row[1] as string), row[2]);
      if (row[0] === "strip") {
        const [, s, chars, both, left, right] = row as [
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        m.check(`strip ${s} ${chars}`, pyStripChars(s, chars), both);
        m.check(`lstrip ${s} ${chars}`, pyStripChars(s, chars, "left"), left);
        m.check(`rstrip ${s} ${chars}`, pyStripChars(s, chars, "right"), right);
      }
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(4000);
  });
});
