// Real Rich layout bytes, with invented cells only. No application database or dataset is opened.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import type { CommandIo } from "../tree.js";
import { richTable, type TableColumn } from "./richTable.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(ROOT, ".venv/bin/python");
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
const SCRIPT = `
import io, json, os, sys
from unittest.mock import patch
from rich.console import Console
from rich.table import Table
results = []
for case in json.load(sys.stdin):
    with patch.dict(os.environ, case["env"], clear=True):
        output = io.StringIO()
        console = Console(file=output, width=case["width"], force_terminal=case["tty"])
        table = Table(title=case.get("title"))
        for column in case["columns"]:
            table.add_column(column["header"], justify=column.get("justify", "left"))
        for row in case["rows"]:
            table.add_row(*row)
        console.print(table)
        results.append(output.getvalue())
print(json.dumps(results, ensure_ascii=False))
`;

it.skipIf(!existsSync(PYTHON))(
  "matches source Rich width collapse, wrapping, ellipsis, alignment and NO_COLOR styles",
  () => {
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
    const home = mkdtempSync(join(tmpdir(), "cashu-rich-layout-"));
    try {
      const result = spawnSync(PYTHON, ["-c", SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        input: JSON.stringify(cases),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CASHU_TESTING: "1",
          CASHU_DATA_DIR: join(home, "data"),
          CASHU_WORKSPACES_DIR: join(home, "workspaces"),
          CASHU_LEGACY_DATA_DIR: join(home, "legacy"),
          CASHU_LAUNCH_AGENTS_DIR: join(home, "LaunchAgents"),
          CASHU_APP_BUNDLE: "none",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const expected = JSON.parse(result.stdout) as string[];
      for (const [index, c] of cases.entries()) {
        const actual = richTable(io(c), c.columns, c.rows, c.title);
        expect(actual, `Rich layout ${index}, width ${c.width}, tty ${c.tty}`).toBe(
          expected[index],
        );
      }
      const noColor = richTable(io(cases[10] as Case), columns, money);
      expect(noColor).toContain("\u001b[1m");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
it("leaves genuinely unsupported markup, controls and extremely narrow layouts explicit", () => {
  const target = io({ width: 80, tty: false, env: {} });
  for (const value of ["[red]markup[/]", "a\nb", "a\tb", ":money_bag:"])
    expect(richTable(target, [{ header: "title" }], [[value]])).toBeNull();
  expect(
    richTable(io({ width: 3, tty: false, env: {} }), [{ header: "title" }], [["x"]]),
  ).toBeNull();
});
