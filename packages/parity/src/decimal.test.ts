import { describe, expect, it } from "vitest";
import { decimalsEqual, isDecimalString } from "./decimal.ts";

describe("decimalsEqual", () => {
  it.each([
    ["1.0", "1.00"],
    ["1E+1", "10"],
    ["1.5E-7", "0.00000015"],
    ["-2.50", "-2.5"],
    ["0.00", "0"],
    ["-0", "0.0"],
    ["100", "1E+2"],
  ])("%s equals %s", (a, b) => {
    expect(decimalsEqual(a, b)).toBe(true);
    expect(decimalsEqual(b, a)).toBe(true);
  });

  it.each([
    ["1.0", "1.01"],
    ["1", "-1"],
    ["10", "1E+2"],
    ["abc", "abc"],
    ["1.0", "one"],
    ["NaN", "NaN"],
    ["1E+99999", "1E+99998"],
  ])("%s differs from %s", (a, b) => {
    expect(decimalsEqual(a, b)).toBe(false);
  });

  it("recognises decimal shapes", () => {
    expect(isDecimalString("-12.50")).toBe(true);
    expect(isDecimalString("1E+1")).toBe(true);
    expect(isDecimalString("12 PLN")).toBe(false);
    expect(isDecimalString("")).toBe(false);
  });
});
