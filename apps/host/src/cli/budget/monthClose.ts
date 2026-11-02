import { budget } from "@cashu/domain";
import { budgetBook, budgetCliCushionEnv, budgetCliSettings } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import { loadStrategy } from "@cashu/store/investments/services";
import type { CommandIo, PortedCommand } from "../tree.js";
import { type BudgetCliDeps, budgetVault, localDate } from "./context.js";
import { monthCloseInput } from "./monthCloseInput.js";
import { monthCloseOutput } from "./monthCloseOutput.js";

const DELEGATE = { kind: "delegate" } as const;

async function runMonthClose(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: BudgetCliDeps,
) {
  const input = monthCloseInput(args);
  const vault = budgetVault(io, root, deps.stores);
  if (input === null || vault === null) return DELEGATE;
  if (io.signal.aborted) return 130;
  const read = vault.store.read.bind(vault.store);
  const profile = mcpProfile(read);
  if (profile === undefined) return DELEGATE;
  let planned: budget.PlannedContribution | null = null;
  const investmentsEnabled = profile.modules.includes("investments");
  if (investmentsEnabled) {
    const files = deps.strategyFiles?.(vault, profile.slug);
    if (!files) return DELEGATE;
    const state = await loadStrategy(vault.store, files);
    if (io.signal.aborted) return 130;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== profile.slug
    )
      return DELEGATE;
    planned = budget.plannedContribution(state.state, state.config);
  }
  const settings = budgetCliSettings(read);
  if (settings === null) return DELEGATE;
  const close = budget.monthClose(budgetBook(read), {
    year: input.year,
    month: input.month,
    today: localDate(deps.now()),
    settings,
    env: budgetCliCushionEnv(read),
    investmentsEnabled,
    planned,
  });
  return monthCloseOutput(io, budget.monthCloseView(close, io.t.language)) ? 0 : DELEGATE;
}

export function monthCloseCommand(deps: BudgetCliDeps): PortedCommand {
  return { name: "month-close", run: (args, io, root) => runMonthClose(args, io, root, deps) };
}
