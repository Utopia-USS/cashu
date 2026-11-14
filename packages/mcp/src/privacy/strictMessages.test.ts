// System messages (portfolio warnings, strategy issues) in strict mode: no quantity or balance
// survives, dates, percentages, indexes and positions do; amounts mode keeps the numbers.
import { describe, expect, it } from "vitest";
import { scrubNumbers, systemText } from "./messages.js";
import { pyDumps } from "./pyJson.js";
import { leakCheck, Redactor } from "./redactor.js";

const SECRET_NUMBERS = ["73", "481", "4131", "3650"];
const STRICT_ALLOWED = /\d{4}-\d{2}-\d{2}|\d+(?:[.,]\d+)?\s?(?:%|pp)|\[\d+\]/gu;
const numbersLeft = (t: string) => t.replace(STRICT_ALLOWED, "").match(/\d+/gu) ?? [];

it("test_scrub_keeps_dates_percentages_indexes_and_positions", () => {
  expect(scrubNumbers("History gap: 412 on 2026-03-02 needs 37 more units of 45")).toBe(
    "History gap: # on 2026-03-02 needs # more units of #",
  );
  expect(scrubNumbers("cash of 9 is -480 on 2026-03-02; counted as 0")).toBe(
    "cash of # is # on 2026-03-02; counted as #",
  );
  expect(scrubNumbers("XMPL is 37.3% (max 30.0%), drift 5 pp")).toBe(
    "XMPL is 37.3% (max 30.0%), drift 5 pp",
  );
  expect(scrubNumbers("rules[3].params: must be at most 1 (got 1.5) at line 12 column 4")).toBe(
    "rules[3].params: must be at most # (got #) at line 12 column 4",
  );
  expect(scrubNumbers("IS3N and EUNL: 12 345,67 PLN, 1,234.56")).toBe("IS3N and EUNL: # PLN, #");
});

// gap messages (a quantity sold beyond the history, the cash
// balance that leaves): the wording of portfolio warnings and strategy issues
const MESSAGES = [
  "History gap: selling 73 PKO on 2025-02-03 needs 73 more units than the history holds",
  "Cash history gap: the PLN cash balance is -481.00 on 2025-02-04; counted as 0",
  "monthly_amount: must be at least 0 (got -4131)",
  "rules[2].params.max_weight: 73 is above 1",
];

describe("test_strict_system_messages_carry_no_quantities_or_balances (message layer; tool flow: S38)", () => {
  it("strict: no number survives except dates, percentages, indexes and positions", () => {
    const redactor = new Redactor({ privacy: "strict" });
    const out = redactor.apply({
      warnings: MESSAGES.map((m) => ({ message: systemText({ strict: true }, m) })),
    });
    leakCheck(out, { strict: true });
    for (const { message } of (out as { warnings: { message: string }[] }).warnings) {
      expect(numbersLeft(message)).toEqual([]);
      for (const n of SECRET_NUMBERS) expect(new RegExp(`\\b${n}\\b`).test(message)).toBe(false);
    }
  });

  it("test_amounts_mode_keeps_the_numbers_of_system_messages", () => {
    const out = new Redactor({ privacy: "amounts" }).apply({
      warnings: MESSAGES.map((m) => ({ message: systemText({ strict: false }, m) })),
    });
    const text = pyDumps(out);
    expect(/\b73\b/.test(text)).toBe(true);
    expect(text).toContain("-481");
  });
});
