import { D } from "@cashu/domain";
import { budgetPeriod, localToday, plotRatios } from "./screenContext";

it("keeps local calendar context and exact period conjunctions", () => {
  expect(localToday(new Date(2026, 2, 4, 23, 59))).toBe("2026-03-04");
  expect(budgetPeriod({ kind: "all" })).toEqual({});
  expect(budgetPeriod({ kind: "quarter", year: 2026, quarter: 1 })).toEqual({
    year: 2026,
    quarter: 1,
  });
  expect(budgetPeriod({ kind: "month", year: 2026, month: 3 })).toEqual({
    year: 2026,
    month: 3,
  });
});

it("uses finite signed geometry for amounts beyond Number while keeping Decimal inputs", () => {
  const large = D(`1${"0".repeat(320)}`);
  const negative = large.neg();
  const values = [negative, D("0.01"), large];
  const geometry = plotRatios(values);
  expect(geometry[0]).toBe(-1);
  expect(geometry[1]).toBeGreaterThanOrEqual(0);
  expect(geometry[1]).toBeLessThan(1e-300);
  expect(geometry[2]).toBe(1);
  expect(geometry.every(Number.isFinite)).toBe(true);
  expect(values.map((value) => value.toString())).toEqual([
    negative.toString(),
    "0.01",
    large.toString(),
  ]);
});
