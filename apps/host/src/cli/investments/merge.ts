import { investmentsCommands } from "@cashu/store";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { DELEGATE } from "./inspection.js";
import { investmentCliText as M } from "./strings.js";

export async function instrumentsMerge(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof DELEGATE> {
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
  let plan = preview.plan;
  if (option !== "--dry-run") {
    if (io.signal.aborted) return 130;
    const key = cliCommandKey();
    const slug = root.profile || io.env.CASHU_PROFILE;
    const current = () =>
      !io.signal.aborted &&
      deps.stores.vaults.get(vault.id) === vault &&
      mcpProfile(vault.store.read.bind(vault.store))?.slug === slug &&
      enabledModuleIds(vault.store.read.bind(vault.store)).has("investments");
    if (!current()) return DELEGATE;
    const result = await runCliVaultCommand(
      vault,
      investmentsCommands.mergeInstruments,
      { source, target },
      key,
      current,
    );
    if (result.kind === "refused" && result.reason in M.mergeRefusal) {
      io.stderr(`${io.t.tr(M.mergeRefusal[result.reason as keyof typeof M.mergeRefusal])}\n`);
      return 1;
    }
    if (result.kind === "not_started" && result.reason === "checkpoint_unavailable")
      io.stderr(`${io.t.tr(M.mergeBackupUnavailable)}\n`);
    if (result.kind !== "completed")
      return reportCliCommandFailure(io, result, key, investmentsCommands.mergeInstruments.id);
    plan = result.value;
    if (!current())
      return reportCliProjectionUnavailable(io, key, investmentsCommands.mergeInstruments.id);
  }
  printConsole(
    io,
    `${io.t.tr(option === "--dry-run" ? M.wouldMerge : M.merged)} ${plan.source} (${plan.sourceName}) ${io.t.tr(M.into)} ${plan.target} (${plan.targetName})`,
    { highlight: false },
  );
  for (const [name, count] of Object.entries(plan.moved).sort(([a], [b]) => a.localeCompare(b)))
    printConsole(
      io,
      `  ${io.t.tr(option === "--dry-run" ? M.moved : M.didMove)} ${count}: ${name}`,
      { highlight: false },
    );
  if (option !== "--dry-run" && vault.native)
    printConsole(io, `${io.t.tr(M.mergeCheckpointSaved)} ${vault.native.checkpointDirectory()}`, {
      highlight: false,
    });
  return 0;
}
