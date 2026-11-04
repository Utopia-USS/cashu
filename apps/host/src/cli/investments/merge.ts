import { investmentsCommands } from "@cashu/store";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { DELEGATE } from "./inspection.js";
import { investmentCliText as M } from "./strings.js";

export function instrumentsMerge(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): number | typeof DELEGATE {
  if (args[0] !== "merge" || args.length < 3 || args.length > 4) return DELEGATE;
  const [_, source, target, option] = args;
  if (!source || !target || (option !== undefined && option !== "--dry-run")) return DELEGATE;
  const parsed = investmentsCommands.mergeInstruments.input.safeParse({ source, target });
  if (!parsed.success) {
    io.stderr(`${io.t.tr(M.mergeNativeIds)}\n`);
    return 2;
  }
  const vault = investmentVault(io, root, deps);
  if (!vault) {
    io.stderr(`${io.t.tr(M.noInvestmentVault)}\n`);
    return 1;
  }
  const preview = investmentsCommands.mergePreview(
    vault.store.read.bind(vault.store),
    source,
    target,
  );
  if (!preview.ok) {
    io.stderr(`${io.t.tr(M.mergeRefusal[preview.reason])}\n`);
    return 1;
  }
  if (option !== "--dry-run") {
    io.stderr(`${io.t.tr(M.mergeBackupUnavailable)}\n`);
    return 1;
  }
  const plan = preview.plan;
  printConsole(
    io,
    `${io.t.tr(M.wouldMerge)} ${plan.source} (${plan.sourceName}) ${io.t.tr(M.into)} ${plan.target} (${plan.targetName})`,
    { highlight: false },
  );
  for (const [name, count] of Object.entries(plan.moved).sort(([a], [b]) => a.localeCompare(b)))
    printConsole(io, `  ${io.t.tr(M.moved)} ${count}: ${name}`, { highlight: false });
  return 0;
}
