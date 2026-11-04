import { allSignals, openSignals } from "@cashu/store/investments/queries";
import { richTable } from "../budget/richTable.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { DELEGATE } from "./inspection.js";
import { investmentCliText as M } from "./strings.js";

export function signals(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): number | typeof DELEGATE {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--history")) return DELEGATE;
  const vault = investmentVault(io, root, deps);
  if (!vault) return DELEGATE;
  const read = vault.store.read.bind(vault.store);
  const history = args[0] === "--history";
  const rows = history
    ? allSignals(read).filter((row) => row.status === "resolved" || row.status === "expired")
    : openSignals(read);
  if (!rows.length) {
    printConsole(io, io.t.tr(M.noSignals));
    return 0;
  }
  const sorted = history
    ? rows
    : [...rows].sort((a, b) => {
        const snoozed = (row: typeof a) =>
          row.snoozedUntil !== null && Date.parse(row.snoozedUntil) > deps.now();
        return (
          Number(snoozed(a)) - Number(snoozed(b)) ||
          Number(a.status !== "active") - Number(b.status !== "active") ||
          Number(a.severity !== "action") - Number(b.severity !== "action") ||
          b.firstSeenAt.localeCompare(a.firstSeenAt)
        );
      });
  const table = richTable(
    io,
    [
      M.columns.id,
      M.columns.severity,
      M.columns.status,
      M.columns.rule,
      M.columns.message,
      M.columns.since,
    ].map((label) => ({ header: io.t.tr(label) })),
    sorted.map((row) => [
      row.gid,
      row.severity,
      row.status,
      row.ruleId,
      row.message,
      row.firstSeenAt.slice(0, 10),
    ]),
    io.t.tr(M.signalsTitle),
  );
  if (table === null) return DELEGATE;
  io.stdout(table);
  for (const row of sorted) printConsole(io, `  ${row.gid}`, { highlight: false });
  return 0;
}
