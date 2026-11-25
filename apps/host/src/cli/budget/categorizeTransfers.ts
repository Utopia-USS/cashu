import { matchTransfersCommand } from "@cashu/store/budget/commands";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "./categorize.strings.js";
import type { CategorizeDeps } from "./categorizeOllama.js";
import { budgetVault } from "./context.js";

const UNHANDLED = { kind: "unhandled" } as const;

export function transferOptions(
  args: readonly string[],
): { readonly reset: boolean; readonly maxDays: number } | null {
  let reset = false;
  let maxDays = 3;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--reset") reset = true;
    else if (arg === "--no-reset") reset = false;
    else if (arg === "--max-days" || arg.startsWith("--max-days=")) {
      const value = arg === "--max-days" ? args[++i] : arg.slice("--max-days=".length);
      if (value === undefined || !/^[+-]?[0-9]+$/.test(value)) return null;
      maxDays = Number(value);
      if (!Number.isSafeInteger(maxDays)) return null;
    } else if (!(arg === "--" && i === args.length - 1)) return null;
  }
  return { reset, maxDays };
}

export async function runMatchTransfers(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: CategorizeDeps,
): Promise<number | typeof UNHANDLED> {
  const input = transferOptions(args);
  if (input === null) return UNHANDLED;
  const vault = budgetVault(io, root, deps.stores);
  if (vault === null) return UNHANDLED;
  const slug = root.profile || io.env.CASHU_PROFILE;
  const isCurrent = () => {
    const read = vault.store.read.bind(vault.store);
    return (
      !io.signal.aborted &&
      deps.stores.vaults.get(vault.id) === vault &&
      mcpProfile(read)?.slug === slug &&
      enabledModuleIds(read).has("budget")
    );
  };
  if (!isCurrent()) return io.signal.aborted ? 130 : UNHANDLED;
  const key = cliCommandKey();
  const result = await runCliVaultCommand(vault, matchTransfersCommand, input, key, isCurrent);
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, matchTransfersCommand.id);
  if (!isCurrent())
    return io.signal.aborted
      ? 130
      : reportCliProjectionUnavailable(io, key, matchTransfersCommand.id);
  if (input.reset) printConsole(io, io.t.tr(S.transferCleared)(result.value.cleared));
  const text = io.t.tr(S.transferMatched)(result.value.matched);
  printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
  return 0;
}
