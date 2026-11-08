import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { D } from "@cashu/domain";
import type { MonthCloseView } from "@cashu/domain/budget";
import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { monthCloseOutput } from "./monthCloseOutput.js";

function outputFor(label: string): { ok: boolean; output: string } {
  const output: string[] = [];
  const io: CommandIo = {
    cwd: realpathSync(tmpdir()),
    env: { COLUMNS: "120" },
    tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    prompt: async () => null,
    stdin: async function* () {},
  };
  const view: MonthCloseView = {
    month: "2026-10",
    complete: true,
    baseCurrency: "PLN",
    firstMonth: "2026-10",
    lastMonth: "2026-10",
    currencies: [
      {
        currency: "PLN",
        income: D("100.00"),
        spending: D("12.34"),
        surplus: D("87.66"),
        cushionTopUp: D("0.00"),
        suggestedTransfer: D("87.66"),
        transactions: 2,
        incomeByCategory: [],
        spendingByCategory: [{ category: "dining", label, amount: D("12.34") }],
      },
    ],
    cushion: null,
    investing: null,
  };
  return { ok: monthCloseOutput(io, view), output: output.join("") };
}

it("renders printable bracket and emoji-alias category labels literally with full totals", () => {
  const result = outputFor("[red]Lunch[/] :money_bag:");
  expect(result.ok).toBe(true);
  expect(result.output).toContain("[red]Lunch[/] :money_bag: 12,34 PLN");
  expect(result.output).toContain("100,00 PLN");
  expect(result.output).toContain("87,66 PLN");
});

it("refuses a control in a label before emitting partial output", () => {
  expect(outputFor("Lunch\u001b[31m")).toEqual({ ok: false, output: "" });
});
