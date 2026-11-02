import type { BudgetSettings } from "@cashu/domain/budget";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";

/** The no-account legacy output; account ids require a separate Python-ID alias contract. */
export function cushionOutput(io: CommandIo, settings: BudgetSettings): boolean {
  const c = settings.cushion;
  if (!c.enabled) {
    printConsole(io, "Cushion rule: off");
    return true;
  }
  if (c.accountIds.length !== 0) return false;
  if (c.targetAmount === null && c.targetMonths === null) return false;
  const target =
    c.targetAmount === null
      ? `${c.targetMonths} months of average spending`
      : c.targetAmount.toString();
  const line = `Cushion rule: on, target ${target}, currency ${c.currency || "base"}, accounts savings accounts, monthly max ${c.monthlyMax === null ? "none" : c.monthlyMax.toString()}`;
  printConsole(io, line);
  return true;
}
