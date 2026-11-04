import { D } from "@cashu/domain";
import { builtinRegistry } from "@cashu/domain/core";
import { addManualPosition } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import { cashMoney } from "../budget/cashOutput.js";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import {
  type LoanAssetDeps,
  localDay,
  selectedVault,
  stillSelected,
  usage,
} from "../nativeContext.js";
import { decimal, parse } from "../nativeInput.js";
import { N } from "../nativeStrings.js";
import type { CommandIo, PortedCommand } from "../tree.js";

export async function runAddPosition(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): Promise<number> {
  const parsed = parse(args, ["--type", "--value", "--currency", "--note"]);
  if (
    !parsed ||
    parsed.args.length !== 1 ||
    !parsed.options.has("--type") ||
    !parsed.options.has("--value")
  )
    return usage(io, io.t.tr(N.positionUsage));
  const [name] = parsed.args;
  const type = parsed.options.get("--type") as string;
  const value = decimal(parsed.options.get("--value"));
  const currency = parsed.options.get("--currency");
  if (
    !name ||
    value === null ||
    !builtinRegistry().accountTypes.ids().includes(type) ||
    (currency !== undefined && !/^[A-Z]{3}$/.test(currency))
  )
    return usage(io, io.t.tr(N.invalidPosition));
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const read = vault.store.read.bind(vault.store);
  const profile = mcpProfile(read);
  if (!profile) return usage(io, io.t.tr(N.profileUnavailable));
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const input = {
    name,
    type,
    value,
    onDate: localDay(deps.now()),
    ...(currency ? { currency } : {}),
    ...(parsed.options.has("--note") ? { note: parsed.options.get("--note") } : {}),
  };
  const result = await runCliVaultCommand(
    vault,
    addManualPosition,
    input,
    key,
    stillSelected(vault, io, root, deps),
  );
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, addManualPosition.id);
  if (!stillSelected(vault, io, root, deps)())
    return reportCliProjectionUnavailable(io, key, addManualPosition.id);
  const account = read<{ gid: string; name: string; currency: string; type: string }>(
    "SELECT gid, name, currency, type FROM accounts WHERE gid = ?",
    result.value.account,
  )[0];
  if (!account) {
    io.stderr(`${io.t.tr(N.positionSavedUncertain)(addManualPosition.id, key)}\n`);
    return 1;
  }
  io.stdout(`${io.t.tr(N.positionSaved)(account.gid, cashMoney(D(value), account.currency))}\n`);
  return 0;
}

export function positionCommands(deps: LoanAssetDeps): PortedCommand[] {
  return [{ name: "add-position", run: (args, io, root) => runAddPosition(args, io, root, deps) }];
}
