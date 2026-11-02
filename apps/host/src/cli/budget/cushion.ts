import { D, floatRepr } from "@cashu/domain";
import type { BudgetSettings } from "@cashu/domain/budget";
import { runCommand, setCushion } from "@cashu/store";
import { budgetCliSettings } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import type { CommandIo, PortedCommand } from "../tree.js";
import { type BudgetCliDeps, budgetVault } from "./context.js";
import { cushionInput } from "./cushionInput.js";
import { cushionOutput } from "./cushionOutput.js";

const DELEGATE = { kind: "delegate" } as const;

function nextSettings(
  current: BudgetSettings,
  input: NonNullable<ReturnType<typeof cushionInput>>,
): {
  enabled: boolean;
  currency: string | null;
  targetAmount: string | null;
  targetMonths: number | null;
  monthlyMax: string | null;
  accounts: string[];
} {
  const old = current.cushion;
  if (input.off) {
    return {
      enabled: false,
      currency: old.currency,
      targetAmount: old.targetAmount?.format("f") ?? null,
      targetMonths: old.targetMonths,
      monthlyMax: old.monthlyMax?.format("f") ?? null,
      accounts: [...old.accountIds],
    };
  }
  const targetAmount =
    input.months !== null
      ? null
      : input.target !== null
        ? D(floatRepr(input.target)).format("f")
        : (old.targetAmount?.format("f") ?? null);
  const targetMonths =
    input.months !== null ? input.months : input.target !== null ? null : old.targetMonths;
  const monthlyMax =
    input.monthlyMax !== null
      ? D(floatRepr(input.monthlyMax)).format("f")
      : (old.monthlyMax?.format("f") ?? null);
  return {
    enabled: true,
    currency: input.currency ?? old.currency,
    targetAmount,
    targetMonths,
    monthlyMax,
    accounts: [...old.accountIds],
  };
}

async function runCushion(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: BudgetCliDeps,
) {
  const input = cushionInput(args);
  const vault = budgetVault(io, root, deps.stores);
  if (input === null || vault === null) return DELEGATE;
  if (io.signal.aborted) return 130;
  const read = vault.store.read.bind(vault.store);
  const current = budgetCliSettings(read);
  if (
    current === null ||
    (current.cushion.accountIds.length !== 0 &&
      !input.off &&
      (input.changing || current.cushion.enabled))
  )
    return DELEGATE;
  if (!input.changing) return cushionOutput(io, current) ? 0 : DELEGATE;
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    const now = budgetCliSettings(vault.store.read.bind(vault.store));
    const slug = root.profile || io.env.CASHU_PROFILE;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug ||
      now === null ||
      (now.cushion.accountIds.length !== 0 && !input.off)
    )
      return DELEGATE;
    const proposed = nextSettings(now, input);
    // The legacy view cannot print an enabled rule without a target; refuse before appending.
    if (proposed.enabled && proposed.targetAmount === null && proposed.targetMonths === null)
      return DELEGATE;
    const result = runCommand(vault.store, vault.writer, setCushion, proposed, vault.env);
    if (!result.ok) return DELEGATE;
    const updated = budgetCliSettings(vault.store.read.bind(vault.store));
    if (updated === null || !cushionOutput(io, updated))
      throw new Error("cushion projection unavailable");
    return 0;
  });
}

export function cushionCommand(deps: BudgetCliDeps): PortedCommand {
  return { name: "cushion", run: (args, io, root) => runCushion(args, io, root, deps) };
}
