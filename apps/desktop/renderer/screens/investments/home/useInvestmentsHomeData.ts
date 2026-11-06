// The data of the ported investments Home (ab24ab6 v2/Home.tsx InvestmentsV2 + its widgets): every request of
// Home.tsx:127-141, useResearchHome and the Import drawer, read from the native store queries and handed over in
// the old JSON shapes (homeAdapters.ts). Store queries suspend until the first read, so `loading` is never true;
// a source the host cannot serve shows as `data: undefined` with `error` (the old views' `ov.error` checks).
import { lang } from "@cashu/i18n";
import { proposalList } from "@cashu/store/core/desktop-proposals";
import {
  researchScreenCommands,
  researchScreenQueries,
} from "@cashu/store/investments/research-screen";
import { reviewScreenQueries } from "@cashu/store/investments/review-screen";
import {
  type ImportPreviewDto,
  investmentDesktopQueries,
  investmentImportCommit,
  investmentImportPreview,
  investmentPreviewInputSchema,
  investmentsRunning,
} from "@cashu/store/investments/screen";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import {
  strategiesQueries,
  strategyInit,
  strategyReload,
} from "@cashu/store/investments/strategies-screen";
import { useCommand, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import type { CommitResult, ImportPreview } from "@cashu/ui-logic/investments/types";
import { showStrip } from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import type { PerfRange, SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import { useCalendarDay } from "../../../shell/useCalendarDay.js";
import { dayReadInstant } from "../../signals/signalModels.js";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import {
  alertsOf,
  allNotesOf,
  calendarOf,
  commitResultOf,
  digestOf,
  importPreviewOf,
  type Loaded,
  loaded,
  macroOf,
  openSignalsOf,
  overviewOf,
  performanceOf,
  positionsOf,
  proposalsOf,
  researchNotes,
  runsOf,
  segmentsOf,
  strategyOf,
  summaryOf,
  topicThesesOf,
  watchlistOf,
  workspaceOf,
} from "./homeAdapters.js";
import { gidOf } from "./legacyWire.js";

const portfolio = investmentDesktopQueries();
const signalsQuery = signalsQueries().screen;
const strategies = strategiesQueries().screen;
const review = reviewScreenQueries().screen;
const research = researchScreenQueries().screen;
const researchCommands = researchScreenCommands();

/** A native reason code as the old views' error text. */
const errorOf = <T>(q: Loaded<T>): Loaded<T> =>
  q.error === null ? q : { ...q, error: label(`error.${q.error}`) ?? q.error };

export interface InvestmentsHomeDataInput {
  /** The account filter as the old Home kept it (a legacy account id from `overview.accounts`); null = all. */
  readonly filter: number | null;
  /** ValueChartWidget's own range (Perf.tsx:31); 1y / ytd / 1m reuse the Home's reads. */
  readonly chartRange?: PerfRange;
}

/** Result of a write: null when it went through, else the message the old toast showed. */
export type WriteOutcome = string | null;

export function useInvestmentsHomeData(input: InvestmentsHomeDataInput) {
  const today = useCalendarDay();
  const { privacy } = useUiEnv();
  const language = lang();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const account = gidOf(input.filter);
  const args = { today, timeZone, lang: language, account };

  // ---- reads (Home.tsx:127-141; the order is the old request order) ---------------------------------------
  const p1y = useQuery(portfolio.portfolio, { ...args, range: "1y" });
  const pAll = useQuery(portfolio.portfolio, { ...args, account: null, range: "1y" });
  const signals = useQuery(signalsQuery, {
    now: dayReadInstant(today),
    today,
    timeZone,
    lang: language,
    privacy,
  });
  const strategy = useQuery(strategies, { lang: language, privacy, selection: null });
  const reviewRead = useQuery(review, {
    today,
    lang: language,
    account: null,
    open: false,
    privacy,
  });
  const pending = useQuery(proposalList, { status: "pending", privacy });
  const pYtd = useQuery(portfolio.portfolio, { ...args, range: "ytd" });
  const p1m = useQuery(portfolio.portfolio, { ...args, range: "1m" });
  const pChart = useQuery(portfolio.portfolio, { ...args, range: input.chartRange ?? "1y" });
  const researchRead = useQuery(research, { today, lang: language });
  const metadata = useQuery(portfolio.metadata, { lang: language });
  // The worker's quote refresh / daily check in flight (old usePriceRefreshState / useRunState), pushed by the host.
  const running = useQuery(investmentsRunning);

  // Signals first: their legacy numbers follow creation order (openSignalsOf) before any other read names one.
  const sig = errorOf(openSignalsOf(signals));
  const ov = errorOf(overviewOf(p1y));
  const pos = errorOf(positionsOf(p1y));
  const allPos = input.filter == null ? loaded(null) : errorOf(positionsOf(pAll));
  const alertsQ = errorOf(alertsOf(signals));
  const watchQ = errorOf(watchlistOf(pAll));
  const strat = errorOf(strategyOf(strategy));
  const dig = errorOf(digestOf(reviewRead));
  const props = loaded(proposalsOf(pending));
  const perf1y = errorOf(performanceOf(p1y));
  const perfYtd = errorOf(performanceOf(pYtd));
  const perf1m = errorOf(performanceOf(p1m));
  const perfChart = errorOf(performanceOf(pChart));

  // Signals scoped to the account filter (Home.tsx:195-200): portfolio-wide ones, instruments held in the
  // filtered accounts and watched-only instruments.
  const inView = new Set((pos.data?.positions ?? []).map((p) => String(p.instrument.id)));
  const watched = new Set((watchQ.data ?? []).map((w) => String(w.instrument_id)));
  const heldAnywhere = (s: SignalV2) =>
    typeof s.held === "boolean" ? s.held : !watched.has(String(s.instrument_id));
  const shown = (sig.data ?? []).filter(
    (s) =>
      input.filter == null ||
      s.instrument_id == null ||
      inView.has(String(s.instrument_id)) ||
      !heldAnywhere(s),
  );

  // ---- research (useResearchHome / research/data.ts: runs, summary, candidates, segments, macro, the week) ----
  const notes = allNotesOf(researchRead);
  const runs = runsOf(researchRead);
  const weekSince = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const researchHome = {
    ran: showStrip(runs),
    runs,
    summary: summaryOf(researchRead),
    candidates: researchNotes(notes, { kind: "candidate", include_dismissed: true }),
    segments: segmentsOf(researchRead),
    macro: macroOf(researchRead),
    /** Story.tsx useWeek: the notes of the last 7 days and the 14-day calendar. */
    weekNotes: researchNotes(notes, { since: weekSince }),
    calendar: errorOf(calendarOf(researchRead)),
    workspace: workspaceOf(researchRead),
    strategyVersion: researchRead.status === "current" ? researchRead.strategyVersion : null,
    /** TopicDrawer's `GET /topics/{key}/thesis`, by segment key. */
    topics: topicThesesOf(researchRead),
    /** Every note the read holds (the note sheet's lookup; dismissed and expired included). */
    notes,
  };

  return {
    today,
    privacy,
    ov,
    pos,
    allPos,
    sig,
    /** `sig` scoped to the account filter (Home.tsx:195-200). */
    signals: shown,
    alertsQ,
    watchQ,
    strat,
    dig,
    props,
    perf1y,
    perfYtd,
    perf1m,
    perfChart,
    research: researchHome,
    importAvailable: metadata.importAvailable,
    brokers: metadata.brokers,
    running,
  };
}
export type InvestmentsHomeData = ReturnType<typeof useInvestmentsHomeData>;

/** Research note actions of the candidate rail, the story strip and the deck's Okazje card (research/data.ts
 * useResearchActions without its toasts): each answers null when it went through, else the message. */
export function useResearchNoteActions() {
  const durable = useDurableCommands();
  const dismiss = useCommand(researchCommands.dismissNote);
  const restore = useCommand(researchCommands.restoreNote);
  const accept = useCommand(researchCommands.acceptCandidate);
  const unaccept = useCommand(researchCommands.undoAcceptCandidate);
  const [busy, setBusy] = useState<number | null>(null);
  const note = async (n: ResearchNote, run: (gid: string) => Promise<WriteOutcome>) => {
    const gid = gidOf(n.id);
    if (gid === null) return label("error.not_found") ?? "not_found";
    setBusy(n.id);
    try {
      return await run(gid);
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    dismiss: (n: ResearchNote) =>
      note(n, async (gid) => {
        const r = await durable.run(`dismiss:${gid}`, dismiss, { note: gid, lang: lang() });
        return r.kind === "completed" ? null : commandFailure(r);
      }),
    restore: (n: ResearchNote) =>
      note(n, async (gid) => {
        const r = await durable.run(`restore:${gid}`, restore, { note: gid, lang: lang() });
        return r.kind === "completed" ? null : commandFailure(r);
      }),
    /** `Obserwuj`: the watchlist row and the draft thesis (`POST /research/{id}/accept`). */
    watch: (n: ResearchNote) =>
      note(n, async (gid) => {
        const r = await durable.run(`accept:${gid}`, accept, { note: gid, lang: lang() });
        return r.kind === "completed" ? null : commandFailure(r);
      }),
    /** Undo of `Obserwuj` (`DELETE /research/{id}/accept`). */
    unwatch: (n: ResearchNote) =>
      note(n, async (gid) => {
        const r = await durable.run(`unaccept:${gid}`, unaccept, { note: gid });
        return r.kind === "completed" ? null : commandFailure(r);
      }),
  };
}

/** The Home's writes: the empty state's strategy init, research candidate actions and the Import drawer. Every
 * write answers null when it went through, else the old toast's message; the readback is the live queries. */
export function useInvestmentsHomeCommands(data: InvestmentsHomeData) {
  const research = useResearchNoteActions();
  const init = useUiAction(strategyInit);
  const reload = useUiAction(strategyReload);
  const preview = useUiAction(investmentImportPreview);
  const commit = useUiAction(investmentImportCommit);
  const strategyRead = useQuery(strategies, {
    lang: lang(),
    privacy: data.privacy,
    selection: null,
  });
  const [stage, setStage] = useState<string | null>(null);

  /** Start's "Z szablonu": postStrategyInit + postStrategyReload (Home.tsx initStrategy). */
  const initStrategy = async (): Promise<WriteOutcome> => {
    if (strategyRead.status !== "current")
      return label(`error.${strategyRead.reason}`) ?? strategyRead.reason;
    const r = await init.run({ revision: strategyRead.revision });
    if (r.status !== "completed") return r.reason;
    if (r.value.status === "recovery_required") return r.value.reason;
    if (r.value.status !== "created_and_recorded")
      await reload.run({ revision: r.value.revision }).catch(() => null);
    return null;
  };

  /** ImportDrawer preview (`POST /imports/preview`): the host asks for the file itself. */
  const previewImport = async (req: {
    account_id: number;
    importer: string;
    mapping: string | null;
  }): Promise<{ preview: ImportPreview } | { error: string } | { cancelled: true }> => {
    const gid = gidOf(req.account_id);
    const parsed = investmentPreviewInputSchema.safeParse({
      account: gid,
      importer: req.importer,
      mappingYaml: req.mapping || null,
    });
    if (!parsed.success) return { error: label("error.invalid") ?? "invalid" };
    const r = await preview.run(parsed.data);
    if (r.status !== "completed") return { error: label(`error.${r.reason}`) ?? r.reason };
    if (r.value.status === "cancelled") return { cancelled: true };
    const dto: ImportPreviewDto = r.value.preview;
    setStage(r.value.status === "previewed" ? r.value.stage : null);
    const row = data.ov.data?.accounts.find((a) => a.id === req.account_id) ?? null;
    return {
      preview: importPreviewOf(
        dto,
        r.value.status === "previewed" ? r.value.stage : null,
        req.importer,
        row,
      ),
    };
  };
  /** ImportDrawer commit (`POST /imports/commit`) of the last preview, with the chosen corrections. */
  const commitImport = async (
    corrections: readonly string[] = [],
  ): Promise<{ result: CommitResult } | { error: string }> => {
    if (stage === null) return { error: label("error.not_found") ?? "not_found" };
    const r = await commit.run({ stage, corrections });
    if (r.status !== "completed") return { error: label(`error.${r.reason}`) ?? r.reason };
    const result = commitResultOf(r.value);
    if (result === null) return { error: "reason" in r.value ? r.value.reason : r.value.status };
    setStage(null);
    return { result };
  };

  return {
    research,
    initStrategy,
    initBusy: init.isPending || reload.isPending,
    previewImport,
    commitImport,
    importBusy: preview.isPending || commit.isPending,
  };
}
export type InvestmentsHomeCommands = ReturnType<typeof useInvestmentsHomeCommands>;
