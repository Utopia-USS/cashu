import { describe, expect, it } from "vitest";
// Python csv.reader semantics: every bank CSV parser (budget/ingestion/statements/*) reads through it.
import { CSV_FIELD_LIMIT, readCsv, readCsvLines } from "./pycsv.js";

describe("readCsv", () => {
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

  it("quotes, doubled quotes and the delimiter inside quotes, like csv.reader", () => {
    expect(readCsv('a;"b;c";"d""e"\n;\n', { delimiter: ";" })).toEqual({
      ok: true,
      rows: [
        ["a", "b;c", 'd"e'],
        ["", ""],
      ],
      lineNum: 2,
    });
    expect(readCsvLines(['x,"y\n', 'z",w\n'], { delimiter: "," })).toEqual({
      ok: true,
      rows: [["x", "y\nz", "w"]],
      lineNum: 2,
    });
  });

  it("strict refuses a stray character after a quote and an unterminated quote", () => {
    expect(readCsv('a,"b"x\n', { delimiter: ",", strict: true })).toMatchObject({
      ok: false,
      reason: "quote_expected",
    });
    expect(readCsv('a,"b"x\n', { delimiter: ",", strict: false })).toMatchObject({
      ok: true,
      rows: [["a", "bx"]],
    });
    expect(readCsv('"abc', { delimiter: ",", strict: true })).toMatchObject({
      ok: false,
      reason: "unexpected_eof",
    });
  });

  it("a bare \\r splits lines only in universal mode", () => {
    expect(readCsv("a\rb\n", { delimiter: ",", lines: "lf" })).toMatchObject({
      ok: false,
      reason: "newline_in_unquoted",
    });
    expect(readCsv("a\rb\n", { delimiter: ",", lines: "universal" })).toMatchObject({
      ok: true,
      rows: [["a"], ["b"]],
    });
  });

  it("the field size limit is 131072 code points", () => {
    const at = readCsv(`${"x".repeat(CSV_FIELD_LIMIT)}\na,b\n`, { delimiter: "," });
    expect(at.ok).toBe(true);
    const over = readCsv(`"${"x".repeat(CSV_FIELD_LIMIT + 1)}"\na,b\n`, { delimiter: "," });
    expect(over).toEqual({ ok: false, reason: "field_limit", lineNum: 1 });
  });
});
