import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { UNHANDLED } from "./inspection.js";
import { investmentCliText as M, macroStatus } from "./strings.js";

export async function macroRefresh(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof UNHANDLED> {
  if (args.length !== 1 || args[0] !== "refresh") return UNHANDLED;
  const vault = investmentVault(io, root, deps);
  if (!vault) {
    io.stderr(`${io.t.tr(M.noInvestmentVault)}\n`);
    return 1;
  }
  const worker = deps.worker?.();
  if (!worker) {
    io.stderr(`${io.t.tr(M.runUnavailable)}\n`);
    return 1;
  }
  const slug = mcpProfile(vault.store.read.bind(vault.store))?.slug;
  const current = () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(vault.store.read.bind(vault.store))?.slug === slug &&
    enabledModuleIds(vault.store.read.bind(vault.store)).has("investments");
  if (!current()) return 130;
  try {
    const result = await worker.refreshMacroCli(vault, current);
    if (!current()) {
      io.stderr(`${io.t.tr(M.contextChanged)}\n`);
      return 1;
    }
    if (result.status !== "ok") {
      io.stderr(`${io.t.tr(result.status === "busy" ? M.runBusy : M.macroUnavailable)}\n`);
      return 1;
    }
    for (const series of result.report.series)
      printConsole(
        io,
        `${series.series} (${series.symbol}): ${io.t.tr(macroStatus[series.status])}, ${series.closes.length} ${io.t.tr(M.bars)}`,
        { highlight: false },
      );
    printConsole(io, `${io.t.tr(M.stored)}: ${result.stored.bars_fetched} ${io.t.tr(M.closes)}`);
    for (const regime of result.regimes) {
      const since = regime.since
        ? `${io.t.tr(M.since)} ${regime.since}`
        : regime.since_min
          ? `${io.t.tr(M.sinceBefore)} ${regime.since_min}`
          : "-";
      const metrics = regime.metrics.map((metric) => `${metric.label} ${metric.text}`).join(", ");
      printConsole(io, `${regime.label}: ${regime.state_label} (${since}); ${metrics}`, {
        highlight: false,
      });
    }
    return result.stored.series_error > 0 ? 1 : 0;
  } catch {
    io.stderr(`${io.t.tr(M.macroFailed)}\n`);
    return 1;
  }
}
