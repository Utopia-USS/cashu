import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { findAccountNumber, parsePlAmount, parsePlDate } from "./plFormats.js";

describe("Polish formats edge cases", () => {
  it("amounts: NaN and Infinity are no amount, the exponent of the text is kept", () => {
    expect(parsePlAmount(null)).toBeNull();
    expect(parsePlAmount("NaN")).toBeNull();
    expect(parsePlAmount("Infinity")).toBeNull();
    const small = parsePlAmount("-0,001");
    expect(small !== "invalid" && small?.toString()).toBe("-0.001");
    const grouped = parsePlAmount("1_000");
    expect(grouped !== "invalid" && grouped?.toString()).toBe("1000");
    expect(parsePlAmount("199 +.")).toBe("invalid");
  });

  it("dates: impossible dates are refused, single-digit day and month accepted", () => {
    expect(parsePlDate("2026-02-30")).toBeNull();
    expect(parsePlDate("0000-01-01")).toBeNull();
    expect(parsePlDate(" 5.1.2024")).toBe("2024-01-05");
    expect(parsePlDate("2024-01-5 ")).toBe("2024-01-05");
  });

  it("account number: 26 digits across spaces, nothing for fewer", () => {
    expect(findAccountNumber(" 3 260475084686 69119957805 233")).toBe("32604750846866911995780523");
    expect(findAccountNumber("x 545701  924102 07945225635801 ")).toBeNull();
    expect(findAccountNumber("")).toBeNull();
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
