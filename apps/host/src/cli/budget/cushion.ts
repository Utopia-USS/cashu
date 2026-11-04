import { D, floatRepr } from "@cashu/domain";
import type { BudgetSettings } from "@cashu/domain/budget";
import { setCushion } from "@cashu/store";
import { budgetCliSettings } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import type { Read } from "@cashu/store/query";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { type BudgetCliDeps, budgetVault } from "./context.js";
import { S } from "./cushion.strings.js";
import { cushionInput } from "./cushionInput.js";
import { cushionOutput } from "./cushionOutput.js";

const UNHANDLED = { kind: "unhandled" } as const;

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
    accounts: input.accounts === null ? [...old.accountIds] : [...input.accounts],
  };
}

function visibleAccounts(read: Read, gids: readonly string[]): boolean {
  return gids.every(
    (gid) =>
      read<{ gid: string }>("SELECT gid FROM accounts WHERE gid = ? AND removed_at IS NULL", gid)
        .length === 1,
  );
}

async function runCushion(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: BudgetCliDeps,
) {
  const input = cushionInput(args);
  const vault = budgetVault(io, root, deps.stores);
  if (input === null || vault === null) return UNHANDLED;
  if (io.signal.aborted) return 130;
  const read = vault.store.read.bind(vault.store);
  const current = budgetCliSettings(read);
  if (current === null) return UNHANDLED;
  if (input.accounts !== null && !visibleAccounts(read, input.accounts)) {
    io.stderr(`${io.t.tr(S.unknownAccount)}\n`);
    return 2;
  }
  if (!input.changing) return cushionOutput(io, current) ? 0 : UNHANDLED;
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const now = budgetCliSettings(vault.store.read.bind(vault.store));
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (
    deps.stores.vaults.get(vault.id) !== vault ||
    mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug ||
    now === null
  )
    return UNHANDLED;
  const proposed = nextSettings(now, input);
  if (!input.off && !visibleAccounts(read, proposed.accounts)) {
    io.stderr(`${io.t.tr(S.unknownAccount)}\n`);
    return 2;
  }
  // The legacy view cannot print an enabled rule without a target; refuse before appending.
  if (proposed.enabled && proposed.targetAmount === null && proposed.targetMonths === null)
    return UNHANDLED;
  const result = await runCliVaultCommand(vault, setCushion, proposed, key, () => {
    const latest = budgetCliSettings(vault.store.read.bind(vault.store));
    return (
      !io.signal.aborted &&
      deps.stores.vaults.get(vault.id) === vault &&
      mcpProfile(vault.store.read.bind(vault.store))?.slug === slug &&
      latest !== null &&
      JSON.stringify(nextSettings(latest, input)) === JSON.stringify(proposed) &&
      (input.off || visibleAccounts(vault.store.read.bind(vault.store), proposed.accounts))
    );
  });
  if (result.kind !== "completed") return reportCliCommandFailure(io, result, key, setCushion.id);
  const updated = budgetCliSettings(vault.store.read.bind(vault.store));
  if (updated === null || !cushionOutput(io, updated))
    return reportCliProjectionUnavailable(io, key, setCushion.id);
  return 0;
}

export function cushionCommand(deps: BudgetCliDeps): PortedCommand {
  return { name: "cushion", run: (args, io, root) => runCushion(args, io, root, deps) };
}
