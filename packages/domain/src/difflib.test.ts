import { describe, expect, it } from "vitest";
import { getCloseMatches, sequenceRatio } from "./difflib.js";
import { loadVectors, Mismatches } from "./testing/vectors.js";

const rows = loadVectors("budget-difflib").rows;

describe("difflib vectors (parity/python/vectors_budget.py)", () => {
  it("ratio and get_close_matches equal Python", () => {
    const columns = rows.find((r) => r[0] === "columns")?.[1] as string[];
    const m = new Mismatches();
    for (const row of rows) {
      if (row[0] === "close")
        m.check(`close ${row[1]}`, getCloseMatches(row[1] as string, columns, 1, 0.75), row[2]);
      if (row[0] === "ratio")
        m.check(
          `ratio ${row[1]} ${row[2]}`,
          sequenceRatio(row[1] as string, row[2] as string),
          row[3],
        );
      if (row[0] === "close_n") {
        const [, word, pool, n, cutoff, want] = row as [
          string,
          string,
          string[],
          number,
          number,
          string[],
        ];
        m.check(`close_n ${word}`, getCloseMatches(word, pool, n, cutoff), want);
      }
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(rows.length - 1);
  });
});
