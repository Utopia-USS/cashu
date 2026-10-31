// The genesis table order of one vault (S26 spec 5.1; events.md 3.3, 11): rows in dependency order,
// each row's events contiguous, rows of a table in id order (signals by 4.7, strategy versions by
// version). Order is not needed for validity (references are plain gids); it keeps subject-less
// events after the keyed events they address and every lifecycle event after its create.
import { readCushion, strategyFilesDiffering } from "./files.js";
import { mapConnectorBinding, mapProposal, mapReview } from "./map/agent.js";
import { mapAssetDetails, mapDepreciation, mapLoan } from "./map/assetsLoans.js";
import {
  mapCashLegClaim,
  mapCategoryRule,
  mapCushion,
  mapImportBatch,
  mapTransaction,
} from "./map/budget.js";
import { type MapContext, mapRows, type RowEvents } from "./map/context.js";
import { mapAccount, mapBalance, mapModule, mapProfile } from "./map/core.js";
import {
  mapInstruments,
  mapInvAccountSettings,
  mapInvImport,
  mapInvTxn,
  mapOverride,
  mapPosition,
  mapRename,
  mapValuation,
} from "./map/investments.js";
import {
  decisionLinks,
  mapDecision,
  mapPlannedDeposit,
  mapStrategyVersions,
  mapThesis,
} from "./map/journal.js";
import { mapNote, mapResearchRun, mapTopicThesis, mapWatchlist } from "./map/research.js";
import { mapAlert, mapRuleRun, mapSignals } from "./map/signals.js";
import type { ProfileScope } from "./source.js";

/** budget.json (spec 4.3): an event for a readable file, none for a missing or invalid one. */
function cushionRows(scope: ProfileScope, ctx: MapContext): RowEvents[] {
  const file = readCushion(ctx.files, scope.profile.slug);
  if (file.kind === "invalid") ctx.count("budget_settings", "budget_json_invalid");
  if (file.kind !== "ok") return [];
  const mapped = ctx.attempt(() => mapCushion(file.cushion, ctx));
  return mapped === undefined ? [] : [mapped];
}

/** D-G7: the strategy files are compared with the latest version, counted, never an event. */
function countStrategyFiles(scope: ProfileScope, ctx: MapContext): void {
  const latest = [...scope.invStrategyVersions].sort(
    (a, b) => b.version - a.version || b.id - a.id,
  )[0];
  const differing = strategyFilesDiffering(ctx.files, scope.profile.slug, latest);
  ctx.count("inv_strategy_versions", "strategy_files_differ", differing);
}

/** Every row of one vault mapped to its events, in the spec 5.1 order. */
export function vaultRows(scope: ProfileScope, ctx: MapContext): RowEvents[] {
  const each = <R>(rows: readonly R[], map: (row: R, ctx: MapContext) => RowEvents | undefined) =>
    mapRows(ctx, rows, map);
  const links = decisionLinks(scope.invDecisionSignals);
  const linked = new Set<number>([...links.values()].flat());
  for (const d of scope.invDecisions) if (d.signalId !== null) linked.add(d.signalId);
  countStrategyFiles(scope, ctx);
  return [
    ...each([scope.profile], mapProfile), // 1
    ...each(scope.profileModules, mapModule), // 2
    ...each(scope.accounts, mapAccount), // 3
    ...cushionRows(scope, ctx), // 4
    ...mapInstruments(ctx), // 5
    ...each(scope.importBatches, mapImportBatch), // 6
    ...each(scope.invImportBatches, mapInvImport), // 7
    ...each(scope.categoryRules, mapCategoryRule), // 8
    ...each(scope.transactions, mapTransaction), // 9: bank rows, claims, cash expenses
    ...each(scope.transactions, mapCashLegClaim), // 9: leg claims after all imports
    ...each(scope.balances, mapBalance), // 10
    ...each(scope.loans, mapLoan), // 11
    ...each(scope.depreciations, mapDepreciation),
    ...each(scope.assetDetails, mapAssetDetails),
    ...each(scope.invAccountSettings, mapInvAccountSettings),
    ...each(scope.connectorBindings, mapConnectorBinding),
    ...each(scope.invTransactions, mapInvTxn), // 12
    ...each(scope.invPositionSnapshots, mapPosition), // 13
    ...each(scope.invInstrumentRenames, mapRename), // 14
    ...each(scope.invManualValuations, mapValuation), // 15
    ...each(scope.invProfileInstruments, mapOverride), // 16
    ...each(scope.watchlistItems, mapWatchlist), // 17
    ...mapStrategyVersions(scope.invStrategyVersions, ctx), // 18
    ...each(scope.invRuleRuns, mapRuleRun), // 19
    ...each(scope.alerts, mapAlert), // 20
    ...mapSignals(scope.invSignals, linked, ctx), // 21
    ...each(scope.invDecisions, (r, c) => mapDecision(r, links, c)), // 22
    ...each(scope.invTheses, mapThesis), // 23
    ...each(scope.invTopicTheses, mapTopicThesis), // 24
    ...each(scope.researchRuns, mapResearchRun), // 25
    ...each(scope.researchNotes, mapNote), // 26
    ...each(scope.reviews, mapReview), // 27
    ...each(scope.proposals, mapProposal), // 28
    ...each(scope.invPlannedDeposits, mapPlannedDeposit), // 29
  ];
}
