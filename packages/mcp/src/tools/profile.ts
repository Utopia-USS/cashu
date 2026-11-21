import { builtinRegistry, MODULE_IDS } from "@cashu/domain/core";
import { market } from "@cashu/domain/investments";
import { mcpBudgetFreshness } from "@cashu/store/budget/queries";
import { enabledModuleIds, mcpCoreFreshness } from "@cashu/store/core";
import {
  lastReview,
  lastRun,
  latestStrategyVersion,
  loadInstruments,
  mcpInvestmentTransactionCount,
  storedTime,
  vaultInstrumentGids,
} from "@cashu/store/investments/queries";
import { moduleSetup } from "@cashu/store/overview";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

const PRIVACY_NOTES = {
  strict: "strict: shares and percentages only, no absolute amounts; never identifiers",
  amounts: "amounts: absolute amounts are sent; identifiers (account numbers, names) never",
};
const SETUP_CONTEXT = { cli: "cashu --profile <profile>", lang: "pl" } as const;
function investmentFreshness(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const { read, prices, marketData } = ctx.store;
  const instruments = loadInstruments(read, vaultInstrumentGids(read));
  let newest: string | null = null;
  if (marketData !== undefined) {
    for (const instrument of instruments.values())
      for (const bar of marketData.series(instrument.id))
        if (newest === null || bar.date > newest) newest = bar.date;
  } else if (prices) {
    for (const instrument of instruments.values()) {
      for (const key of market.marketSymbolsOf(instrument))
        for (const bar of prices.bars(key)) {
          if (newest === null || bar.date > newest) newest = bar.date;
        }
    }
  }
  const run = lastRun(read);
  const listLength = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return {
    transactions: L.count(mcpInvestmentTransactionCount(read)),
    prices_newest: L.date(newest),
    fx_newest: L.date(ctx.store.fxNewest),
    strategy: L.category(latestStrategyVersion(read)?.state ?? "missing"),
    last_run: run
      ? {
          status: L.category(run.status),
          trigger: L.category(run.trigger),
          as_of: L.date(run.asOf),
          finished_at: L.date(run.finishedAt ? storedTime(run.finishedAt) : null),
          new_signals: L.count(listLength(run.report.new)),
          escalated_signals: L.count(listLength(run.report.escalated)),
          errors: L.count(run.errors.length),
        }
      : null,
  };
}
export function profileOverview(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const { read } = ctx.store;
  const enabled = enabledModuleIds(read);
  const names = (module: string) =>
    ctx.store.toolInventory
      .filter((t) => t.module === module || t.also.includes(module))
      .map((t) => t.name)
      .sort()
      .map(L.text);
  const summary = mcpCoreFreshness(read);
  const freshness: Record<string, L.LabelledTree> = {
    balances_newest: L.date(summary.balancesNewest),
  };
  if (enabled.has("budget")) {
    const b = mcpBudgetFreshness(read);
    freshness.budget = { transactions_newest: L.date(b.newest), transactions: L.count(b.count) };
  }
  if (enabled.has("investments")) freshness.investments = investmentFreshness(ctx);
  return {
    privacy: L.category(ctx.privacy),
    privacy_note: L.text(PRIVACY_NOTES[ctx.privacy]),
    base_currency: L.category(ctx.store.profile.baseCurrency),
    today: L.date(ctx.today),
    modules: [...builtinRegistry().modules.values()].map((spec) => {
      const on = enabled.has(spec.id);
      const setup = on ? moduleSetup(read, spec.id, SETUP_CONTEXT) : null;
      return {
        id: L.category(spec.id),
        name: L.text(spec.name),
        enabled: L.flag(on),
        setup_state: L.category(setup?.ok ? setup.value.state : null),
        skill: L.text(spec.skill),
        tools: on ? names(spec.id) : [],
      };
    }),
    core_tools: names("core"),
    freshness,
    pending_proposals: L.count(summary.pendingProposals),
    last_reviews: [...enabled].sort().flatMap((module) => {
      const row = lastReview(read, module);
      return row ? [{ module: L.category(module), done_at: L.date(storedTime(row.doneAt)) }] : [];
    }),
  };
}
export function setupStatus(ctx: ToolContext<NativeToolStore>, args: ToolArgs): L.LabelledTree {
  const module = String(args.module);
  const spec = builtinRegistry().modules.get(module);
  const status = moduleSetup(ctx.store.read, module, SETUP_CONTEXT);
  if (!spec || !status.ok) throw new ToolError(`unknown module; known: ${MODULE_IDS.join(", ")}`);
  const next = status.value.steps.find((s) => s.status === "on");
  return {
    module: L.category(module),
    enabled: L.flag(enabledModuleIds(ctx.store.read).has(module)),
    state: L.category(status.value.state),
    steps: status.value.steps.map((s) => ({
      id: L.category(s.id),
      title: L.text(s.title),
      description: L.text(s.description),
      status: L.category(s.status),
      actions: s.actions.map((a) => ({
        kind: L.category(a.kind),
        label: L.text(a.label),
        target: L.text(a.target),
      })),
    })),
    next_action: next ? { step: L.category(next.id), title: L.text(next.title) } : null,
    skill: L.text(spec.skill),
  };
}
