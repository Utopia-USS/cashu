import { toStorage } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import type { views } from "@cashu/domain/investments";
import * as research from "@cashu/domain/investments/research";
import { enabledModuleIds } from "../../core/queries.js";
import { type ChangeSource, defineQuery, type Read } from "../../query.js";
import {
  type CurrentStrategySource,
  combinedChanges,
  type InvestmentMarketSource,
  type InvestmentScreenClock,
} from "../desktop/sources.js";
import { latestRun, noteByGid, notes } from "../research/queries.js";
import { viewInstant } from "../research/rows.js";
import { runsView } from "../research/views.js";
import { nativeResearchNotes, readResearchInputs } from "./inputs.js";
import { type ResearchScreenExtraSources, sourceForVault } from "./sources.js";

export interface ResearchScreenSources extends ResearchScreenExtraSources {
  readonly strategy?: CurrentStrategySource;
  readonly market?: InvestmentMarketSource;
  readonly clock?: InvestmentScreenClock & { readonly changes?: ChangeSource };
}

export type ResearchScreenArgs = {
  readonly today: string;
  readonly lang: UiLang;
};

function wireSegments(value: ReturnType<ReturnType<typeof readResearchInputs>["segments"]>) {
  return value.status !== "current"
    ? value
    : {
        status: "current" as const,
        value: value.value,
        trends: {
          bySegment: Object.fromEntries(value.trends.bySegment),
          labels: Object.fromEntries(value.trends.labels),
        },
      };
}

function context(read: Read, sources: ResearchScreenSources, args: ResearchScreenArgs) {
  if (!enabledModuleIds(read).has("investments"))
    return { status: "unavailable" as const, reason: "module_disabled" };
  const currentClock = sources.clock?.current();
  if (!currentClock) return { status: "unavailable" as const, reason: "clock_unavailable" };
  const strategy = sources.strategy?.current(read);
  if (!strategy || strategy.status !== "current")
    return {
      status: "unavailable" as const,
      reason: strategy?.reason ?? "current_files_unavailable",
    };
  const market = sources.market?.current(read);
  if (!market) return { status: "unavailable" as const, reason: "market_unavailable" };
  return {
    status: "current" as const,
    request: {
      ...market,
      vault: strategy.vault,
      strategy: strategy.state,
      clock: {
        today: args.today,
        now: currentClock.now,
        timeZone: currentClock.timeZone,
      } satisfies views.ViewClock,
      lang: args.lang,
      macro: sourceForVault(read, sources.macro?.current(read)),
      calendar: sourceForVault(read, sources.calendar?.current(read)),
    },
    revision: strategy.revision,
  };
}

/** The base rows remain readable when valuation or current files are unavailable. */
function base(read: Read, sources: ResearchScreenSources, args: ResearchScreenArgs) {
  const clock = sources.clock?.current();
  if (!clock) return { status: "unavailable" as const, reason: "clock_unavailable" };
  const now = viewInstant(toStorage(clock.now));
  const rows = notes(read, now, { includeDismissed: true, includeExpired: true });
  return {
    status: "current" as const,
    now,
    notes: nativeResearchNotes(read, rows, now, args.lang),
    runs: runsView(read, now),
    lastRun: latestRun(read)?.gid ?? null,
  };
}

export function researchScreenQueries(sources: ResearchScreenSources = {}) {
  const changes = combinedChanges(
    ...[
      ...(sources.strategy ? [sources.strategy.changes] : []),
      ...(sources.market ? [sources.market.changes] : []),
      ...(sources.macro ? [sources.macro.changes] : []),
      ...(sources.calendar ? [sources.calendar.changes] : []),
      ...(sources.workspace ? [sources.workspace.changes] : []),
      ...(sources.clock?.changes ? [sources.clock.changes] : []),
    ],
  );
  return {
    screen: defineQuery({
      id: "investments.research.screen",
      changes,
      run(read, args: ResearchScreenArgs) {
        if (!enabledModuleIds(read).has("investments"))
          return { status: "unavailable" as const, reason: "module_disabled" };
        const common = base(read, sources, args);
        if (common.status !== "current") return common;
        const prepared = context(read, sources, args);
        const workspace = sourceForVault(read, sources.workspace?.current(read));
        if (prepared.status !== "current")
          return {
            status: "partial" as const,
            reason: prepared.reason,
            today: args.today,
            notes: common.notes,
            runs: common.runs,
            lastRun: common.lastRun,
            workspace,
          };
        const session = readResearchInputs(read, prepared.request);
        return {
          status: "current" as const,
          today: args.today,
          revision: prepared.revision,
          strategyVersion: prepared.request.strategy.version?.version ?? null,
          strategyChanged: prepared.request.strategy.changed,
          notes: session.notes,
          candidateRail: session.candidateRail,
          runs: session.runs,
          lastRun: session.lastRun,
          positions: session.positions,
          positionStatus: session.positionStatus,
          summary: session.summary,
          topics: session.topics,
          segments1w: wireSegments(session.segments("1w")),
          segments4w: wireSegments(session.segments("4w")),
          macro: session.macro,
          calendar: session.calendar,
          digest: session.digest(null),
          workspace,
        };
      },
    }),
    topic: defineQuery({
      id: "investments.research.topic",
      changes,
      run(read, args: ResearchScreenArgs & { readonly key: string }) {
        if (!enabledModuleIds(read).has("investments"))
          return { status: "unavailable" as const, reason: "module_disabled" };
        if (!research.isNoteSegment(args.key))
          return { status: "refused" as const, reason: "unknown_segment" };
        const common = base(read, sources, args);
        if (common.status !== "current") return common;
        return {
          status: "current" as const,
          notes: common.notes.filter((n) => n.segment === args.key),
        };
      },
    }),
    asset: defineQuery({
      id: "investments.research.asset",
      changes,
      run(read, args: ResearchScreenArgs & { readonly instrument: string }) {
        if (!enabledModuleIds(read).has("investments"))
          return { status: "unavailable" as const, reason: "module_disabled" };
        const common = base(read, sources, args);
        if (common.status !== "current") return common;
        return {
          status: "current" as const,
          notes: common.notes.filter((n) => n.instrument_id === args.instrument),
        };
      },
    }),
    note: defineQuery({
      id: "investments.research.note",
      changes,
      run(read, args: ResearchScreenArgs & { readonly note: string }) {
        if (!enabledModuleIds(read).has("investments"))
          return { status: "unavailable" as const, reason: "module_disabled" };
        const clock = sources.clock?.current();
        if (!clock) return { status: "unavailable" as const, reason: "clock_unavailable" };
        const row = noteByGid(read, args.note);
        if (!row) return { status: "refused" as const, reason: "no_note" };
        const now = viewInstant(toStorage(clock.now));
        return {
          status: "current" as const,
          note: nativeResearchNotes(read, [row], now, args.lang)[0],
        };
      },
    }),
  };
}

export type ResearchScreenSnapshot = ReturnType<
  ReturnType<typeof researchScreenQueries>["screen"]["run"]
>;
