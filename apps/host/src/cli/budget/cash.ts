import { floatRepr, pyUpper } from "@cashu/domain";
import { isCategoryKey } from "@cashu/domain/budget";
import { addCashExpenseCli, runCommand } from "@cashu/store";
import { cashCliSnapshot } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import type { CommandIo, PortedCommand } from "../tree.js";
import { cashAddInput, cashReadInput } from "./cashInput.js";
import { cashAddLine, cashNoPool, cashReadOutput } from "./cashOutput.js";
import { type BudgetCliDeps, budgetVault } from "./context.js";

const DELEGATE = { kind: "delegate" } as const;
const ISO_CURRENCY = /^[A-Z]{3}$/;

function safeEcho(text: string): boolean {
  return (
    text.length > 0 &&
    !text.includes("[") &&
    !text.includes("]") &&
    !Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) < 32 || ch.codePointAt(0) === 127)
  );
}

async function readCash(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: BudgetCliDeps,
) {
  const requested = cashReadInput(args);
  const vault = budgetVault(io, root, deps.stores);
  if (requested === undefined || vault === null) return DELEGATE;
  const state = cashCliSnapshot(vault.store.read.bind(vault.store), requested);
  if (state === undefined) return DELEGATE;
  if (state === null) cashNoPool(io);
  else if (!cashReadOutput(io, state)) return DELEGATE;
  return 0;
}

async function addCash(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: BudgetCliDeps,
) {
  const input = cashAddInput(args);
  const vault = budgetVault(io, root, deps.stores);
  if (input === null || vault === null) return DELEGATE;
  if (io.signal.aborted) return 130;
  if (!isCategoryKey(input.category) || !safeEcho(input.title) || input.amount === 0)
    return DELEGATE;
  const currency = input.currency ? pyUpper(input.currency) : null;
  if (currency !== null && !ISO_CURRENCY.test(currency)) return DELEGATE;
  // Python stores the title verbatim. The CLI command retains it; the API command still strips it.
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    const slug = root.profile || io.env.CASHU_PROFILE;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug
    )
      return DELEGATE;
    const result = runCommand(
      vault.store,
      vault.writer,
      addCashExpenseCli,
      {
        amount: floatRepr(input.amount),
        title: input.title,
        category: input.category,
        currency,
        onDate: input.date,
      },
      vault.env,
    );
    if (!result.ok) return DELEGATE;
    cashAddLine(io, input.amount, input.title, input.category);
    return 0;
  });
}

export function cashCommands(deps: BudgetCliDeps): PortedCommand[] {
  return [
    { name: "cash", run: (args, io, root) => readCash(args, io, root, deps) },
    { name: "cash-add", run: (args, io, root) => addCash(args, io, root, deps) },
  ];
}
