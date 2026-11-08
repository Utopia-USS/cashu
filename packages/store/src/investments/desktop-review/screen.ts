/** A synchronous tracked snapshot; all transported values are plain DTOs. */
import { utcIso } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { asProfileId, performance as perf, views } from "@cashu/domain/investments";
import { enabledModuleIds } from "../../core/queries.js";
import { type ChangeSource, defineQuery, type Read } from "../../query.js";
import type { InvestmentScreenClock } from "../desktop/sources.js";
import { combinedChanges } from "../desktop/sources.js";
import { readResearchInputs } from "../desktop-research/inputs.js";
import type { ResearchScreenSources } from "../desktop-research/screen.js";
import { sourceForVault } from "../desktop-research/sources.js";
import { lastReview } from "../queries/reviews.js";
import { viewInstant } from "../research/rows.js";
import { readReviewDigestInputs } from "../views/reviews.js";
import { readReviewDecide } from "./decide.js";
import { type ReviewSectorRow, reviewBriefs, reviewMacroChanges } from "./prose.js";

export type ReviewScreenArgs = {
  readonly today: string;
  readonly lang: UiLang;
  readonly account?: string | null;
  readonly open?: boolean;
  readonly privacy?: boolean;
};
export type ReviewScreenSources = ResearchScreenSources & {
  readonly clock?: InvestmentScreenClock & { readonly changes?: ChangeSource };
};

function assemble(read: Read, args: ReviewScreenArgs, sources: ReviewScreenSources) {
  if (args.privacy) return { status: "unavailable" as const, reason: "privacy" };
  if (!enabledModuleIds(read).has("investments"))
    return { status: "unavailable" as const, reason: "module_disabled" };
  const currentClock = sources.clock?.current();
  if (!currentClock) return { status: "unavailable" as const, reason: "clock_unavailable" };
  const strategy = sources.strategy?.current(read);
  if (strategy?.status !== "current")
    return {
      status: "unavailable" as const,
      reason: strategy?.reason ?? "current_files_unavailable",
    };
  const market = sources.market?.current(read);
  if (!market) return { status: "unavailable" as const, reason: "market_unavailable" };
  const clock = { today: args.today, now: currentClock.now, timeZone: currentClock.timeZone };
  const session = readResearchInputs(read, {
    ...market,
    vault: strategy.vault,
    strategy: strategy.state,
    clock,
    lang: args.lang,
    macro: sourceForVault(read, sources.macro?.current(read)),
    calendar: args.open
      ? sourceForVault(read, sources.calendar?.current(read))
      : { status: "unavailable", reason: "calendar_not_requested" },
  });
  const input = readReviewDigestInputs(
    read,
    {
      ...market,
      vault: asProfileId(strategy.vault),
      strategy: strategy.state,
      clock,
      lang: args.lang,
    },
    session,
  );
  if (!input.ok) return { status: "unavailable" as const, reason: input.reason };
  const digest = views.reviewDigestView(input.value);
  const segments = session.segments("1w");
  const attribution = segments.status === "current" ? segments.value : null;
  const sectorRows = views.reviewSectorRows<ReviewSectorRow>(
    (attribution?.segments ?? []).map((row) => ({
      key: row.segment,
      label: row.label,
      contribution: row.contribution,
      weight: row.weight,
      ret: row.return,
      currency: false,
      briefs: reviewBriefs(row.briefs.slice(0, 1)),
    })),
    attribution?.unassigned
      ? {
          key: "unassigned",
          label: attribution.unassigned.label,
          contribution: attribution.unassigned.contribution,
          weight: attribution.unassigned.weight,
          ret: attribution.unassigned.return,
          currency: false,
          briefs: [],
        }
      : null,
    attribution
      ? {
          key: "currency",
          label: "",
          contribution: attribution.currency.contribution,
          weight: null,
          ret: null,
          currency: true,
          briefs: [],
        }
      : null,
  );
  const movers = views.reviewMovers(
    [
      ...(attribution?.segments ?? []),
      ...(attribution?.unassigned ? [attribution.unassigned] : []),
    ].flatMap((row) =>
      row.instruments.flatMap((inst) =>
        inst.return === null
          ? []
          : [
              {
                id: inst.instrument_id,
                label: inst.label ?? inst.instrument_id,
                ret: inst.return,
                contribution: inst.contribution,
              },
            ],
      ),
    ),
  );
  const notes = session.notes.filter(
    (note) => note.observed_at !== null && note.observed_at.slice(0, 10) >= digest.since,
  );
  const events = views.reviewEvents(notes, (note) => ({
    dismissed: note.dismissed,
    kind: note.kind,
    strength: note.strength,
    relation: note.thesis_relation,
    observedAt: note.observed_at ?? "",
  }));
  const ideas = views.reviewIdeas(session.notes, Date.parse(utcIso(clock.now)), (note) => ({
    kind: note.kind,
    dismissed: note.dismissed,
    accepted: !!note.candidate?.accepted_at,
    expired: note.expired,
    expiresAt: note.expires_at,
    observedAt: note.observed_at ?? "",
  }));
  // Digest exact-time baseline was already resolved by the shared adapter.
  const research = session.digest(viewInstant(input.value.period.sinceAt));
  const macroChanges = reviewMacroChanges(research.value.macro_changes);
  const decide = readReviewDecide(read, {
    now: utcIso(clock.now),
    since: digest.since_at,
    account: args.account ?? null,
    today: clock.today,
    research: research.value,
  });
  const railDecide = readReviewDecide(read, {
    now: utcIso(clock.now),
    since: digest.since_at,
    account: args.account ?? null,
    today: clock.today,
    research: research.value,
    includeSnoozed: true,
    lastReviewAt: lastReview(read, "investments")?.doneAt ?? null,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const week = session.computed === null ? null : perf.performanceView(session.computed, "1m");
  const year = session.computed === null ? null : perf.performanceView(session.computed, "1y");
  const change = views.reviewChangeSince(week?.points ?? [], digest.since);
  const move = change.pct;
  const benchmarkStale = views.reviewBenchmarkStale(week?.benchmark);
  const benchmark = benchmarkStale ? null : change.bench;
  const sigma = views.reviewWeeklySigma(year?.points ?? []);
  const order = digest.review.cards.filter((id): id is views.ReviewCardId =>
    views.REVIEW_CARD_ORDER.some((known) => known === id),
  );
  const deck = views.reviewCardMembership(
    {
      sectors: sectorRows.some((row) => !row.currency),
      positions: [...movers.down, ...movers.up].some(
        (row) => Math.abs(row.ret) >= views.REVIEW_MOVER_MIN,
      ),
      events: events.length > 0 || research.value.macro_changes.length > 0,
      ideas: ideas.length > 0,
      decide: decide.items.length > 0,
    },
    order.length ? order : undefined,
  );
  const skipped = deck.skipped.map((row) => ({
    ...row,
    reason:
      ((row.id === "sectors" || row.id === "positions") && segments.status !== "current") ||
      (row.id === "events" && input.researchSources.macro.status !== "current")
        ? "source_unavailable"
        : row.reason,
  }));
  return {
    status: "current" as const,
    vault: strategy.vault,
    revision: strategy.revision,
    now: utcIso(clock.now),
    today: clock.today,
    name: digest.review.name,
    due: digest.review_due,
    last: lastReview(read, "investments") ?? null,
    next: digest.review.next_on,
    hasData: session.positions.length > 0 || !digest.value.now.isZero(),
    digest,
    cards: deck.cards,
    skipped,
    world: {
      move,
      benchmark,
      benchmarkStale,
      sigma,
      verdict: views.reviewWorldVerdict(move, benchmark, sigma),
      drawdown: year?.points.at(-1)?.drawdown ?? null,
      maxDrawdown: year?.summary?.max_drawdown?.depth ?? null,
    },
    sectors: sectorRows,
    sectorVerdict: views.reviewSectorVerdict(sectorRows, move),
    movers,
    events,
    ideas,
    candidateStates: session.notes
      .filter((note) => note.kind === "candidate")
      .map((note) => ({
        id: note.id,
        accepted: !!note.candidate?.accepted_at,
        dismissed: note.dismissed,
      })),
    decide,
    railDecide,
    macro: session.macro,
    macroChanges,
    riskBrief:
      session.macro.status === "current"
        ? (reviewBriefs(
            session.macro.value.find((row) => row.key === "risk")?.brief
              ? [session.macro.value.find((row) => row.key === "risk")?.brief]
              : [],
          )[0] ?? null)
        : null,
    research: research.value,
    briefs: reviewBriefs(
      [...(attribution?.segments ?? [])]
        .filter((row) => row.weight > 0 && row.briefs.length > 0)
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 2)
        .flatMap((row) => row.briefs.slice(0, 1)),
    ),
    sectorBriefs: reviewBriefs(
      (attribution?.segments ?? [])
        .filter(
          (row) => row.briefs.length > 0 && sectorRows.some((sector) => sector.key === row.segment),
        )
        .slice(0, 3)
        .flatMap((row) => row.briefs.slice(0, 1)),
    ),
    sources: input.researchSources,
    calendar: session.calendar,
  };
}
export function reviewScreenQueries(sources: ReviewScreenSources = {}) {
  return {
    screen: defineQuery({
      id: "investments.review.screen",
      changes: combinedChanges(
        ...[
          sources.strategy?.changes,
          sources.market?.changes,
          sources.macro?.changes,
          sources.calendar?.changes,
          sources.clock?.changes,
        ].filter((source) => source !== undefined),
      ),
      run: (read, args: ReviewScreenArgs) => assemble(read, args, sources),
    }),
  };
}
export type ReviewScreenResult = ReturnType<typeof assemble>;
