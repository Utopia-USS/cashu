import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import { DurableWriteUnknown } from "@cashu/store/investments/services";
import { WorkerTickBusy } from "../../worker/service.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { UNHANDLED } from "./inspection.js";
import { investmentCliText as M, runStatus } from "./strings.js";

function countStatuses(items: readonly { readonly status: string }[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${status} ${count}`).join(", ");
}

export async function runInvestment(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof UNHANDLED> {
  if (args.some((arg) => arg !== "--all" && arg !== "--offline")) return UNHANDLED;
  const all = args.includes("--all");
  const offline = args.includes("--offline");
  const vaults = all
    ? [...deps.stores.vaults.values()].filter((vault) =>
        enabledModuleIds(vault.store.read.bind(vault.store)).has("investments"),
      )
    : [investmentVault(io, root, deps)].filter((vault) => vault !== null);
  if (vaults.length === 0) {
    io.stderr(`${io.t.tr(M.noInvestmentVault)}\n`);
    return 1;
  }
  const worker = deps.worker?.();
  if (!worker) {
    io.stderr(`${io.t.tr(M.runUnavailable)}\n`);
    return 1;
  }
  const slugs = new Map(
    vaults.map((vault) => [vault.id, mcpProfile(vault.store.read.bind(vault.store))?.slug]),
  );
  const current = () =>
    !io.signal.aborted &&
    vaults.every(
      (vault) =>
        deps.stores.vaults.get(vault.id) === vault &&
        mcpProfile(vault.store.read.bind(vault.store))?.slug === slugs.get(vault.id) &&
        enabledModuleIds(vault.store.read.bind(vault.store)).has("investments"),
    );
  if (!current()) return 130;
  try {
    const { report, outcomes } = await worker.runInvestmentCli(vaults, offline, current);
    if (!current()) {
      io.stderr(`${io.t.tr(M.contextChanged)}\n`);
      return 1;
    }
    if (report?.status === "busy") {
      io.stderr(`${io.t.tr(M.runBusy)}\n`);
      return 1;
    }
    if (report?.market) {
      const instruments = [...report.market.reports.values()].flatMap((row) => row.instruments);
      const fx = [...report.market.reports.values()].flatMap((row) => row.fx);
      printConsole(
        io,
        `${io.t.tr(M.market)}: ${countStatuses(instruments)}; FX ${countStatuses(fx)}`,
      );
    }
    if (!report?.market) {
      const marketError = report?.profiles
        .flatMap((row) => row.result?.errors ?? [])
        .find((error) => error.startsWith("market refresh failed:"));
      if (marketError) printConsole(io, `${io.t.tr(M.marketFailed)}: ${marketError}`);
    }
    if (report?.macro)
      printConsole(io, `${io.t.tr(M.macro)}: ${countStatuses(report.macro.series)}`);
    if (report?.macroError) printConsole(io, `${io.t.tr(M.macroFailed)}: ${report.macroError}`);
    let failed = false;
    for (const vault of vaults) {
      const row = report?.profiles.find((item) => item.vault === vault.id);
      const slug = slugs.get(vault.id) ?? vault.id;
      if (!row) {
        const outcome = outcomes.get(vault.id);
        printConsole(io, `${slug}: ${io.t.tr(runStatus[outcome?.status ?? "failed"])}`);
        failed ||= outcome?.status === "failed" || outcome === undefined;
        continue;
      }
      const stats = row.result?.stats;
      printConsole(
        io,
        `${slug}: ${io.t.tr(runStatus[row.status])} (${io.t.tr(M.strategyLabel)} ${String(stats?.strategy ?? "-")}); ${io.t.tr(M.holdings)} ${String(stats?.holdings ?? 0)}, ${io.t.tr(M.total)} ${String(stats?.total_base ?? "-")} ${String(stats?.base_currency ?? "")}; ${io.t.tr(M.signalsNew)} ${row.result?.newSignals.length ?? 0}, ${io.t.tr(M.signalsEscalated)} ${row.result?.escalatedSignals.length ?? 0}; ${io.t.tr(M.alertsResolved)} ${String(stats?.alert_signals_resolved ?? 0)}, ${io.t.tr(M.plansResolved)} ${String(stats?.plan_signals_resolved ?? 0)}, ${io.t.tr(M.researchResolved)} ${String(stats?.research_signals_resolved ?? 0)}`,
        { highlight: false },
      );
      for (const signal of [
        ...(row.result?.newSignals ?? []),
        ...(row.result?.escalatedSignals ?? []),
      ])
        printConsole(io, `  [${signal.severity}] ${signal.message}`, { highlight: false });
      for (const error of row.result?.errors ?? [])
        printConsole(io, `  ${io.t.tr(M.profileError)} ${error}`, { highlight: false });
      if (row.error) printConsole(io, `  ${io.t.tr(M.profileError)} ${row.error}`);
      failed ||= row.status === "failed" || row.status === "refused";
    }
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof DurableWriteUnknown) {
      io.stderr(
        `${io.t.tr(M.unknownOutcome)} cashu command-status ${error.commandId} ${error.key}. ${io.t.tr(M.doNotRetry)}\n`,
      );
      return 1;
    }
    io.stderr(`${io.t.tr(error instanceof WorkerTickBusy ? M.runBusy : M.runFailed)}\n`);
    return 1;
  }
}
