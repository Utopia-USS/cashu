// Rich layout bytes frozen from the retired Python CLI (fixtures/richTable.json), with invented cells
// only. No application database or dataset is opened.
import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import richTableFixture from "./fixtures/richTable.json" with { type: "json" };
import { richTable, type TableColumn } from "./richTable.js";

/** Rich's output for each case below, in order (`Console(width, force_terminal=tty).print(Table)`). */
const EXPECTED: readonly string[] = richTableFixture;
interface Case {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly string[])[];
  readonly width: number;
  readonly tty: boolean;
  readonly env: Record<string, string>;
  readonly title?: string;
}
function io(c: Pick<Case, "width" | "tty" | "env">): CommandIo {
  return {
    cwd: "/tmp",
    env: { ...c.env, COLUMNS: String(c.width) },
    tty: { stdin: false, stdout: c.tty, stderr: false, columns: c.width },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout() {},
    stderr() {},
    prompt: async () => null,
    stdin: async function* () {},
  };
}
it("matches source Rich width collapse, wrapping, ellipsis, alignment and NO_COLOR styles", () => {
  const columns: TableColumn[] = [
    { header: "currency" },
    { header: "income", justify: "right" },
    { header: "spending", justify: "right" },
    { header: "surplus", justify: "right" },
    { header: "cushion", justify: "right" },
    { header: "suggested transfer", justify: "right" },
  ];
  const money = [
    [
      "PLN",
      "12 345 678,90 PLN",
      "1 234 567,89 PLN",
      "11 111 111,01 PLN",
      "876 543,21 PLN",
      "10 234 567,80 PLN",
    ],
    ["EUR", "1 200,00 EUR", "345,67 EUR", "854,33 EUR", "0,00 EUR", "854,33 EUR"],
  ];
  const cases: Case[] = [];
  for (const width of [40, 60, 80, 100, 200]) {
    cases.push({ columns, rows: money, width, tty: false, env: {} });
    cases.push({ columns, rows: money, width, tty: true, env: { FORCE_COLOR: "1" } });
  }
  cases.push({
    columns,
    rows: money,
    width: 80,
    tty: true,
    env: { FORCE_COLOR: "1", NO_COLOR: "1" },
  });
  for (const width of [20, 24, 32, 40])
    cases.push({
      columns: [{ header: "title" }, { header: "amount", justify: "right" }],
      rows: [
        ["A long synthetic merchant title with words", "12 345,67 PLN"],
        ["ReferenceWithoutAnySpacesAtAll", "-50,00 PLN"],
        ["表🙂 café", "0,00 EUR"],
      ],
      title: "Synthetic wrapped table",
      width,
      tty: true,
      env: { FORCE_COLOR: "1", NO_COLOR: "1" },
    });
  cases.push({
    columns: [{ header: "category" }, { header: "count", justify: "right" }],
    rows: [],
    title: "Category distribution",
    width: 80,
    tty: false,
    env: {},
  });
  for (const [index, c] of cases.entries()) {
    const actual = richTable(io(c), c.columns, c.rows, c.title);
    expect(actual, `Rich layout ${index}, width ${c.width}, tty ${c.tty}`).toBe(EXPECTED[index]);
  }
  const noColor = richTable(io(cases[10] as Case), columns, money);
  expect(noColor).toContain("\u001b[1m");
});
it("renders markup-shaped cells literally without interpreting Rich tags or emoji aliases", () => {
  const target = io({ width: 80, tty: false, env: {} });
  const table = richTable(
    target,
    [{ header: "[title]" }, { header: "amount", justify: "right" }],
    [["[red]markup[/] :money_bag:", "12,34 PLN"]],
    "[Cash] :money_bag:",
  );
  expect(table).not.toBeNull();
  expect(table).toContain("[Cash] :money_bag:");
  expect(table).toContain("[title]");
  expect(table).toContain("[red]markup[/] :money_bag:");
  expect(table).toContain("12,34 PLN");
});
it("leaves controls and extremely narrow layouts explicit", () => {
  const target = io({ width: 80, tty: false, env: {} });
  for (const value of ["a\nb", "a\tb", "a\u001b[31m", "a\u007f"])
    expect(richTable(target, [{ header: "title" }], [[value]])).toBeNull();
  expect(
    richTable(io({ width: 3, tty: false, env: {} }), [{ header: "title" }], [["x"]]),
  ).toBeNull();
});
