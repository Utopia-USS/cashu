import { describe, expect, it } from "vitest";
import { CSV_FIELD_LIMIT, type CsvResult, readCsv, readCsvLines } from "./pycsv.js";
import { loadVectors, Mismatches } from "./testing/vectors.js";

const vectors = loadVectors("budget-csv");

function asVector(r: CsvResult): unknown[] {
  return r.ok ? ["ok", r.rows, r.lineNum] : ["err", r.reason, r.lineNum];
}

describe("csv.reader vectors (parity/python/vectors_budget.py)", () => {
  it("random texts, every delimiter, strict on / off, both line modes", () => {
    const m = new Mismatches();
    for (const row of vectors.rows) {
      if (row[0] === "text") {
        const [, text, delimiter, strict, lines, want] = row as [
          string,
          string,
          string,
          boolean,
          "lf" | "universal",
          unknown,
        ];
        m.check(
          JSON.stringify(row.slice(1, 5)),
          asVector(readCsv(text, { delimiter, strict, lines })),
          want,
        );
      } else if (row[0] === "lines") {
        const [, lines, delimiter, strict, want] = row as [
          string,
          string[],
          string,
          boolean,
          unknown,
        ];
        m.check(
          JSON.stringify(row.slice(1, 4)),
          asVector(readCsvLines(lines, { delimiter, strict })),
          want,
        );
      }
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(3300);
  });

  it("the field size limit (131072 code points) fails like Python", () => {
    expect(CSV_FIELD_LIMIT).toBe(131072);
    for (const row of vectors.rows.filter((r) => r[0] === "limit")) {
      const [, n, quoted, want] = row as [string, number, boolean, unknown[]];
      const long = "x".repeat(n);
      const r = readCsv(`${quoted ? `"${long}"` : long}\na,b\n`, { delimiter: "," });
      const got = r.ok
        ? [
            "ok",
            r.rows.map((cells) =>
              cells.length === 1 && (cells[0] as string).length > 2
                ? [(cells[0] as string).length]
                : cells,
            ),
            r.lineNum,
          ]
        : ["err", r.reason, r.lineNum];
      expect(got).toEqual(want);
    }
  });
});
