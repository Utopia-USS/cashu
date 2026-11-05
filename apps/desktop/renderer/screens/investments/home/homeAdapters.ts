// Native query snapshots -> the ab24ab6 JSON payloads (frontend/src/modules/investments/api.ts, v2/api.ts,
// v2/research/api.ts, core/proposalsApi.ts). The native projections are the parity views, so most payloads only
// pass the legacy wire boundary (legacyWire.ts); the storage rows (signals, alerts, theses, proposals, import) are
// renamed field by field. Each adapter also applies what the old API client did on top of the response
// (`isShownSignal`, `digestShown`, `normNote`, `normAttribution`, `normMacro`, the research list defaults).
import { investments as inv } from "@cashu/domain";
import type { ProposalListRow } from "@cashu/store/core/desktop-proposals";
import type { ResearchScreenSnapshot } from "@cashu/store/investments/research-screen";
import type { ReviewScreenResult } from "@cashu/store/investments/review-screen";
import type {
  ImportPreviewDto,
  InvestmentCommitResult,
  PortfolioSnapshot,
} from "@cashu/store/investments/screen";
import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import type { StrategiesSnapshot } from "@cashu/store/investments/strategies-screen";
import type {
  CommitResult,
  Decision,
  ImportPreview,
  ImportWarning,
  StrategyStatus,
  Thesis,
} from "@cashu/ui-logic/investments/types";
import { digestShown, isShownSignal } from "@cashu/ui-logic/investments/v2/logic";
import { normMacro } from "@cashu/ui-logic/investments/v2/research/macro";
import { normAttribution } from "@cashu/ui-logic/investments/v2/research/segments";
import type {
  DigestResearch,
  MacroRegimes,
  ResearchNote,
  ResearchRun,
  ResearchSummary,
  SegmentAttribution,
  Workspace,
} from "@cashu/ui-logic/investments/v2/research/types";
import type {
  Alert,
  DigestV2,
  MarketCalendar,
  OverviewV2,
  Performance,
  PositionsV2,
  Proposal,
  SignalV2,
  WatchItem,
} from "@cashu/ui-logic/investments/v2/types";
import { internInOrder, legacyId, legacyIdOf, wire } from "./legacyWire.js";

/** A failed source as the old `useAsync` showed it: data undefined, a message in `error`. */
export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: string | null;
  /** Store queries suspend until their first read: never true, kept for the old `loading` checks. */
  readonly loading: false;
}
export const loaded = <T>(data: T): Loaded<T> => ({ data, error: null, loading: false });
const failed = <T>(reason: string): Loaded<T> => ({
  data: undefined,
  error: reason,
  loading: false,
});

// ---- portfolio query: overview, positions, watchlist, performance -----------------------------------------

type ReadyPortfolio = Extract<PortfolioSnapshot, { status: "ready" }>;
const portfolioReady = (p: PortfolioSnapshot): p is ReadyPortfolio => p.status === "ready";
const reasonOf = (p: { status: string; reason?: string }) => p.reason ?? p.status;

export const overviewOf = (p: PortfolioSnapshot): Loaded<OverviewV2> =>
  portfolioReady(p) ? loaded(wire<OverviewV2>(p.overview)) : failed(reasonOf(p));
export const positionsOf = (p: PortfolioSnapshot): Loaded<PositionsV2> =>
  portfolioReady(p) ? loaded(wire<PositionsV2>(p.positions)) : failed(reasonOf(p));
export const watchlistOf = (p: PortfolioSnapshot): Loaded<WatchItem[]> =>
  portfolioReady(p) ? loaded(wire<WatchItem[]>(p.watch)) : failed(reasonOf(p));
export const performanceOf = (p: PortfolioSnapshot): Loaded<Performance | null> =>
  portfolioReady(p) ? loaded(wire<Performance>(p.performance)) : failed(reasonOf(p));

// ---- signals query: open signals, alerts, theses ------------------------------------------------------------

type SignalRow = ReadySignals["open"][number];
type DecisionRow = SignalRow["decisions"][number];

const decisionOf = (d: DecisionRow): Decision => ({
  id: legacyId(d.gid),
  signal_id: legacyIdOf(d.signal),
  instrument_id: legacyIdOf(d.instrument),
  account_id: legacyIdOf(d.account),
  action: d.action,
  quantity: d.quantity === null ? null : Number(d.quantity),
  price: d.price === null ? null : Number(d.price),
  currency: d.currency,
  reason: d.reason,
  created_at: d.createdAt,
  signal_ids: d.signals.map(legacyId),
});

function signalOf(row: SignalRow, held: ReadonlySet<string>): SignalV2 {
  return {
    id: legacyId(row.gid),
    rule_id: row.ruleId,
    kind: row.kind,
    dedup_key: row.dedupKey,
    severity: row.severity,
    status: row.status,
    message: row.message,
    instrument_id: legacyIdOf(row.instrument),
    instrument_label: row.instrumentLabel,
    account_id: legacyIdOf(row.account),
    payload: wire<Record<string, unknown>>(row.payload),
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    acknowledged_at: row.acknowledgedAt,
    closed_at: row.closedAt,
    snoozed_until: row.snoozedUntil,
    snoozed: row.snoozed,
    decisions: row.decisions.map(decisionOf),
    polarity: row.polarity,
    source: row.source,
    alert_id: legacyIdOf(row.alert),
    message_code: row.messageCode,
    message_params: wire<Record<string, unknown> | null>(row.messageParams),
    current: row.current,
    held: row.instrument === null ? null : held.has(row.instrument),
  };
}

type SignalsSnapshot = ReadySignals | { status: "unavailable"; reason: string };

/** `GET /signals?status=open` then `isShownSignal` (v2/api.ts getSignalsV2). Numbers are handed out in creation
 * order first (`signals` is newest first), so the old `b.id - a.id` tie-breaks keep their meaning. */
export function openSignalsOf(s: SignalsSnapshot): Loaded<SignalV2[]> {
  if (s.status !== "ready") return failed(s.reason);
  internInOrder([...s.signals].reverse().map((row) => row.gid));
  const held = new Set(s.held);
  return loaded(s.open.map((row) => signalOf(row, held)).filter(isShownSignal));
}

type AlertRow = ReadySignals["alerts"][number];
function alertOf(row: AlertRow): Alert {
  const i = row.instrumentDetail;
  return {
    id: legacyId(row.gid),
    kind: row.kind,
    scope: row.scope,
    instrument_id: legacyIdOf(row.instrument),
    instrument:
      i === null
        ? null
        : {
            id: legacyId(i.id),
            label: inv.instrumentLabel(i),
            symbol: i.symbol,
            name: i.name,
            isin: i.isin,
            currency: i.currency,
            asset_class: i.assetClass,
            valuation_mode: i.valuationMode,
          },
    params: wire<Record<string, unknown>>(row.params),
    unit: row.unit,
    polarity: row.polarity,
    severity: row.severity,
    title: row.title,
    note: row.note,
    tag: row.tag,
    source: row.source,
    created_by: row.createdBy,
    status: row.status,
    cooldown_days: row.cooldownDays,
    expires_at: row.expiresAt,
    snoozed_until: row.snoozedUntil,
    last_triggered_at: row.lastTriggeredAt,
    last_checked_at: row.lastCheckedAt,
    last_value:
      row.lastValue === null || !Number.isFinite(Number(row.lastValue))
        ? null
        : Number(row.lastValue),
    signal:
      row.signal === null
        ? null
        : {
            id: legacyId(row.signal.gid),
            status: row.signal.status,
            message: row.signal.message,
            first_seen_at: row.signal.firstSeenAt,
          },
    state: wire<Alert["state"]>(row.state),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** `GET /alerts?status=all` (every alert the owner has, deleted ones excluded by the read). */
export const alertsOf = (s: SignalsSnapshot): Loaded<Alert[]> =>
  s.status === "ready" ? loaded(s.alerts.map(alertOf)) : failed(s.reason);

type ThesisRow = ReadySignals["theses"][number];
const thesisOf = (t: ThesisRow): Thesis => ({
  id: legacyId(t.gid),
  instrument_id: legacyId(t.instrument),
  entry_type: t.entryType,
  thesis: t.thesis,
  invalidation: t.invalidation,
  exit_plan: t.exitPlan,
  size_plan: t.sizePlan,
  reviewed_at: t.reviewedAt,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
  exit_plan_changed_at: t.exitPlanChangedAt,
});

/** `GET /instruments/{id}/theses` per instrument, newest by `updated_at` (the deck's `thesesQ`). */
export function newestThesesOf(s: SignalsSnapshot, ids: readonly number[]): Map<number, Thesis> {
  const out = new Map<number, Thesis>();
  if (s.status !== "ready") return out;
  const want = new Set(ids);
  for (const t of s.theses.map(thesisOf)) {
    if (!want.has(t.instrument_id)) continue;
    const seen = out.get(t.instrument_id);
    if (!seen || String(t.updated_at ?? "").localeCompare(String(seen.updated_at ?? "")) > 0)
      out.set(t.instrument_id, t);
  }
  return out;
}

// ---- strategy, proposals ---------------------------------------------------------------------------------

/** `GET /strategy` (StrategyStatus). */
export const strategyOf = (s: StrategiesSnapshot): Loaded<StrategyStatus> =>
  s.status === "current" ? loaded(wire<StrategyStatus>(s.strategy)) : failed(s.reason);

/** core/connectors.ts INV_PROPOSAL_KINDS. */
const INV_PROPOSAL_KINDS: ReadonlySet<string> = new Set([
  "strategy",
  "custom_rule",
  "rule",
  "import",
]);
/** `GET /proposals?status=pending` filtered to the investments kinds (Home.tsx:137). */
export const proposalsOf = (rows: readonly ProposalListRow[]): Proposal[] =>
  rows
    .filter((p) => INV_PROPOSAL_KINDS.has(p.kind))
    .map((p) => ({
      id: legacyId(p.gid),
      kind: p.kind,
      status: p.status,
      summary: p.summary,
      reason: p.reason,
      source: p.source,
      created_at: p.createdAt,
      reviewed_at: p.reviewedAt,
    }));

// ---- review query: the digest ------------------------------------------------------------------------------

/** `GET /review-digest` then `digestShown` (v2/api.ts getDigestV2); the digest's `research` block (RS CONTRACT
 * 6) comes from the same native read. */
export function digestOf(r: ReviewScreenResult): Loaded<DigestV2> {
  if (r.status !== "current") return failed(r.reason);
  const digest = wire<DigestV2>(r.digest);
  const research = wire<DigestResearch>(r.research);
  return loaded(digestShown({ ...digest, research } as DigestV2 & { research: DigestResearch }));
}

// ---- research query --------------------------------------------------------------------------------------

type ResearchSnapshot = ResearchScreenSnapshot;
type ResearchReady = Extract<ResearchSnapshot, { status: "current" | "partial" }>;
const researchRows = (r: ResearchSnapshot): ResearchReady | null =>
  r.status === "current" || r.status === "partial" ? r : null;

/** research/api.ts normNote. */
function normNote(n: ResearchNote): ResearchNote {
  return {
    ...n,
    sources: Array.isArray(n.sources) ? n.sources : [],
    strength: Number(n.strength) || 1,
    summary: n.summary ?? "",
    theme: n.theme ?? null,
    segment: n.segment ?? null,
    segment_label: n.segment_label ?? null,
    instrument_id: n.instrument_id ?? (n.instrument ? Number(n.instrument.id) : null),
  };
}

/** Every note the native read holds (dismissed and expired included), as legacy notes. */
export const allNotesOf = (r: ResearchSnapshot): ResearchNote[] =>
  (researchRows(r)?.notes ?? []).map((n) => normNote(wire<ResearchNote>(n)));

export interface NoteQuery {
  kind?: string | null;
  since?: string | null;
  include_dismissed?: boolean;
  include_expired?: boolean;
  limit?: number;
}
/** `GET /research?...` over the native notes (research_api.py list_notes): newest observation first, `since` by
 * storing time, dismissed and expired left out unless asked for, at most 200 by default. */
export function researchNotes(notes: readonly ResearchNote[], q: NoteQuery = {}): ResearchNote[] {
  const since = q.since ?? null;
  return notes
    .filter(
      (n) =>
        (!q.kind || n.kind === q.kind) &&
        (q.include_dismissed || !n.dismissed) &&
        (q.include_expired || !n.expired) &&
        (since === null || (n.created_at ?? n.observed_at) >= since),
    )
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
    .slice(0, q.limit ?? 200);
}

export const runsOf = (r: ResearchSnapshot): ResearchRun[] =>
  wire<ResearchRun[]>(researchRows(r)?.runs ?? []);

export function summaryOf(r: ResearchSnapshot): ResearchSummary | null {
  if (r.status !== "current" || r.summary.status !== "current") return null;
  const s = wire<ResearchSummary>(r.summary.value);
  return { ...s, instruments: s.instruments ?? [] };
}

/** `GET /research/segments?window=1w` (normAttribution); null when the native read has none. */
export function segmentsOf(r: ResearchSnapshot): SegmentAttribution | null {
  if (r.status !== "current" || r.segments1w.status !== "current") return null;
  return normAttribution(wire<unknown>(r.segments1w.value), "1w");
}

/** `GET /research/macro` (normMacro): `as_of` = the newest regime's data day. */
export function macroOf(r: ResearchSnapshot): MacroRegimes | null {
  if (r.status !== "current" || r.macro.status !== "current") return null;
  const regimes = wire<{ as_of?: string | null }[]>(r.macro.value);
  const asOf = regimes.reduce<string | null>(
    (best, x) => (x.as_of && (best === null || x.as_of > best) ? x.as_of : best),
    null,
  );
  return normMacro({ as_of: asOf, regimes });
}

/** `GET /calendar?days=14`; the error code as the old hook's `error`. */
export function calendarOf(r: ResearchSnapshot): Loaded<MarketCalendar | null> {
  if (r.status !== "current") return failed(r.reason);
  return r.calendar.status === "current"
    ? loaded(wire<MarketCalendar>(r.calendar.value))
    : failed(r.calendar.reason);
}

/** The review deck's `GET /calendar?days=14`: the review projection reads it only while the deck is open. */
export function reviewCalendarOf(r: ReviewScreenResult): Loaded<MarketCalendar | null> {
  if (r.status !== "current") return failed(r.reason);
  return r.calendar.status === "current"
    ? loaded(wire<MarketCalendar>(r.calendar.value))
    : failed(r.calendar.reason);
}

/** `GET /workspace` (research/api.ts getWorkspace). */
export function workspaceOf(r: ResearchSnapshot): Workspace | null {
  const w = researchRows(r)?.workspace;
  if (w?.status !== "current") return null;
  return {
    path: w.value.path,
    exists: w.value.exists,
    claude_command: w.value.command,
    routine_command: w.value.routine,
    skill_installed: w.value.exists ? w.value.skillInstalled : false,
    skill_installed_at: null,
  };
}

// ---- import drawer ---------------------------------------------------------------------------------------

const warningOf = (w: ImportPreviewDto["warnings"][number]): ImportWarning => ({
  message: w.message,
  row: w.row,
  kind: w.kind,
  blocking: w.blocking,
  ...("code" in w && typeof w.code === "string" ? { code: w.code } : {}),
});

/** The native preview as `POST /imports/preview` answered it (api.ts ImportPreview). */
export function importPreviewOf(
  p: ImportPreviewDto,
  stage: string | null,
  requested: string,
  broker: { broker: string; broker_name: string } | null,
): ImportPreview {
  const counts = p.counts;
  const r = p.reconciliation;
  return {
    file_id: stage ?? "",
    file_name: p.fileName,
    size: p.size,
    account: {
      id: legacyId(p.account.gid),
      name: p.account.name,
      broker: broker?.broker ?? "",
      broker_name: broker?.broker_name ?? "",
    },
    importer: {
      id: p.importer.id,
      name: p.importer.name,
      detected: [...p.importer.detected],
      requested,
    },
    can_commit: p.canCommit,
    warnings: p.warnings.map(warningOf),
    errors: p.errors.map(warningOf),
    previous_imports: p.previousBatches.map((b) => ({
      batch_id: legacyId(b.gid),
      at: b.createdAt,
      file_name: p.fileName,
    })),
    account_hint: p.accountHint,
    counts:
      counts === null
        ? null
        : {
            rows: counts.rows,
            new: counts.new,
            duplicates: counts.duplicates,
            positions: counts.positions,
            renames: counts.renames,
            status_changes: counts.statusChanges,
            new_instruments: counts.newInstruments,
            warnings: p.warnings.length,
            errors: p.errors.length,
          },
    rows: p.rows.map((row) => ({
      row: row.index,
      date: row.tradeDate,
      type: row.type,
      instrument:
        row.instrument === null
          ? null
          : {
              id: legacyId(row.instrument.id),
              label: row.instrument.label,
              new: p.newInstruments.some((n) => n.id === row.instrument?.id),
            },
      quantity: row.quantity === null ? null : Number(row.quantity),
      price: row.price === null ? null : Number(row.price),
      currency: row.currency,
      amount: Number(row.cashAmount),
      cash_currency: row.cashCurrency,
      status: row.duplicate ? "duplicate" : "new",
    })),
    new_instruments: [],
    renames: [...p.renames],
    status_changes: [...p.statusChanges],
    reconciliation:
      r === null
        ? null
        : {
            account_id: legacyId(r.accountId),
            as_of: r.asOf,
            diffs: r.diffs.map((d) => ({
              instrument_id: legacyId(d.instrumentId),
              label:
                p.rows.find((row) => row.instrument?.id === d.instrumentId)?.instrument?.label ??
                d.instrumentId,
              broker_quantity: Number(d.brokerQuantity),
              computed_quantity: Number(d.computedQuantity),
              delta: Number(d.brokerQuantity) - Number(d.computedQuantity),
              kind: d.kind,
              currency: d.currency,
              correction: null,
            })),
            mismatches: r.diffs.filter((d) => d.kind !== "match").length,
            warnings: [...r.warnings],
          },
  };
}

/** `POST /imports/commit` (api.ts CommitResult); null when the native commit did not commit. */
export function commitResultOf(r: InvestmentCommitResult): CommitResult | null {
  if (r.status !== "committed") return null;
  const c = r.result;
  return {
    batch_id: legacyId(c.batch),
    inserted: c.inserted,
    duplicates: c.duplicates,
    new_instrument_ids: c.newInstruments.map(legacyId),
    positions: c.positions,
    renames: c.renames,
    status_changes: c.statusChanges,
    corrections: c.corrections,
    archive_path: c.archive,
    planned_booked: c.plannedBooked.map(legacyId),
  };
}
