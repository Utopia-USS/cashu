// The CLI table renderer on invented cells only: it fits the terminal width, keeps markup-shaped
// text literal and refuses control characters. No application database or dataset is opened.
import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { richTable, type TableColumn } from "./richTable.js";

function io(c: { width: number; tty: boolean; env: Record<string, string> }): CommandIo {
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
it("fits every line into the terminal width and keeps each amount whole", () => {
  const columns: TableColumn[] = [
    { header: "currency" },
    { header: "income", justify: "right" },
    { header: "spending", justify: "right" },
  ];
  const rows = [
    ["PLN", "12 345 678,90 PLN", "1 234 567,89 PLN"],
    ["EUR", "1 200,00 EUR", "345,67 EUR"],
  ];
  for (const width of [40, 80]) {
    const table = richTable(io({ width, tty: false, env: {} }), columns, rows, "Synthetic");
    expect(table).not.toBeNull();
    for (const line of (table ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(width);
  }
  const wide = richTable(io({ width: 120, tty: false, env: {} }), columns, rows) ?? "";
  for (const amount of rows.flat()) expect(wide).toContain(amount);
  const styled = richTable(
    io({ width: 80, tty: true, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }),
    columns,
    rows,
  );
  expect(styled).toContain("\u001b[1m");
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
