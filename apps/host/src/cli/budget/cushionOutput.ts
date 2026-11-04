import type { BudgetSettings } from "@cashu/domain/budget";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "./cushion.strings.js";

/** Render native account gids without inventing local Python ids. */
export function cushionOutput(io: CommandIo, settings: BudgetSettings): boolean {
  const c = settings.cushion;
  if (!c.enabled) {
    printConsole(io, io.t.tr(S.off));
    return true;
  }
  if (c.targetAmount === null && c.targetMonths === null) return false;
  const target =
    c.targetAmount === null
      ? io.t.tr(S.months)(c.targetMonths as number)
      : c.targetAmount.toString();
  const accounts = c.accountIds.length
    ? `[${c.accountIds.join(", ")}]`
    : io.t.tr(S.savingsAccounts);
  const line = io.t.tr(S.on)(
    target,
    c.currency || io.t.tr(S.base),
    accounts,
    c.monthlyMax === null ? io.t.tr(S.none) : c.monthlyMax.toString(),
  );
  printConsole(io, line);
  return true;
}
