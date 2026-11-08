import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { loadVectors, Mismatches } from "../../testing/vectors.js";
import { findAccountNumber, parsePlAmount, parsePlDate } from "./plFormats.js";

const vectors = loadVectors("budget-plformats");

function amountVector(value: string | null): unknown {
  const d = parsePlAmount(value);
  if (d === "invalid") return { error: "InvalidOperation" };
  return d === null ? null : [d.toString(), d.exp];
}

describe("Polish formats vectors (the retired Python vectors_budget.py)", () => {
  it("parse_pl_amount, parse_pl_date and find_account_number equal Python", () => {
    const m = new Mismatches();
    for (const [kind, input, want] of vectors.rows as [string, string | null, unknown][]) {
      if (kind === "amount") m.check(`amount ${input}`, amountVector(input), want);
      else if (kind === "date") m.check(`date ${input}`, parsePlDate(input), want);
      else m.check(`account ${input}`, findAccountNumber(input ?? ""), want);
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(vectors.rows.length);
  });
});

// tests/test_parsing.py
describe("test_parsing.py", () => {
  // test_parse_pl_amount
  it("parses Polish amounts", () => {
    expect(parsePlAmount("-1 234,56 PLN")).toEqual(D("-1234.56"));
    expect(parsePlAmount("1.234,56")).toEqual(D("1234.56"));
    expect(parsePlAmount("123,45")).toEqual(D("123.45"));
    expect(parsePlAmount("")).toBeNull();
    expect(parsePlAmount("  ")).toBeNull();
  });

  // test_parse_pl_date
  it("parses Polish dates", () => {
    expect(parsePlDate("2024-01-05")).toBe("2024-01-05");
    expect(parsePlDate("05.01.2024")).toBe("2024-01-05");
    expect(parsePlDate("garbage")).toBeNull();
  });

  it("keeps the kept quirks Q1 and Q2", () => {
    expect(parsePlAmount("1.234")).toEqual(D("1.234")); // Q2: a bare dot is the decimal point
    expect(parsePlAmount("1-2")).toBe("invalid"); // Q1: the caller refuses the file
  });
});
