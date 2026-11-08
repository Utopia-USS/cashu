import { describe, expect, it } from "vitest";
import { CSV_FIELD_LIMIT, type CsvResult, readCsv, readCsvLines } from "./pycsv.js";
import { loadVectors, Mismatches } from "./testing/vectors.js";

const vectors = loadVectors("budget-csv");

function asVector(r: CsvResult): unknown[] {
  return r.ok ? ["ok", r.rows, r.lineNum] : ["err", r.reason, r.lineNum];
}

describe("csv.reader vectors (the retired Python vectors_budget.py)", () => {
  it("bounds completed records and retained columns while preserving quoted newlines and discarded-field validation", () => {
    expect(
      readCsv('a,b,c,d\n"e\nf",g,h,i\n', { delimiter: ",", maxColumns: 0, collectWidths: true }),
    ).toEqual({ ok: true, rows: [[], []], rowWidths: [4, 4], lineNum: 3 });
    expect(
      readCsv('a,b,c\n"line\nnext",x,y\nunterminated\rbad', {
        delimiter: ",",
        maxRecords: 2,
        maxColumns: 2,
      }),
    ).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["line\nnext", "x"],
      ],
      lineNum: 3,
    });
    expect(
      readCsv(`a,b,${"x".repeat(CSV_FIELD_LIMIT + 1)}\n`, { delimiter: ",", maxColumns: 2 }),
    ).toMatchObject({ ok: false, reason: "field_limit" });
    expect(readCsv('a,b\n"x\ny",z\n', { delimiter: "," })).toEqual({
      ok: true,
      rows: [
        ["a", "b"],
        ["x\ny", "z"],
      ],
      lineNum: 3,
    });
  });
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
    expect(m.checked).toBe(79);
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
