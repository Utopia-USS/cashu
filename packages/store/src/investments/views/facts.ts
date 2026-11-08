/** Live semantic facts. No wall-clock-dependent result is retained across reads. */
import { toStorage } from "@cashu/domain";
import { builtinRegistry, type UiLang } from "@cashu/domain/core";
import {
  asAccountId,
  asImportBatchId,
  asInstrumentId,
  effectivePlan,
  type InstrumentId,
  openedOn,
  parseAccountWrapper,
  parseSignalSeverity,
  parseSignalStatus,
  toCurrency,
  type ValuedHolding,
  type views,
} from "@cashu/domain/investments";
import { canonicalImporterId } from "@cashu/domain/investments/importing";
import * as research from "@cashu/domain/investments/research";
import type { SignalPolarity } from "@cashu/domain/investments/rules";
import { alerts, watchlist } from "../queries/alerts.js";
import { importBatches } from "../queries/import-preview.js";
import { marks, type Read, storedTime } from "../queries/shared.js";
import {
  allSignals,
  lastGoodRunGid,
  openSignals,
  ruleRuns,
  type SignalView,
  signalByGid,
} from "../queries/signals.js";
import {
  accountSettings,
  brokerageAccounts,
  latestPositionSnapshot,
} from "../queries/transactions.js";
import { noteRows, researchable, unreadByInstrument } from "../research/queries.js";
import {
  instantView,
  noteRanks,
  type ResearchNote,
  scoredNote,
  viewInstant,
} from "../research/rows.js";
import { healthByInstrument } from "../research/views.js";
import { byCreation, creationRanks, newestFirst, rankOf } from "./stableOrder.js";

const institutions = builtinRegistry().institutions;
/** Canonical gid is a display tie only, not creation chronology for identity accounts. */
export function brokerageAccountFacts(read: Read, lang: UiLang): views.BrokerageAccountFact[] {
  const batches = newestFirst(read, "imports", importBatches(read), (row) => row.createdAt);
  return brokerageAccounts(read)
    .sort((a, b) => (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0))
    .map((account) => {
      const settings = accountSettings(read, account.gid);
      const batch = batches.find((row) => row.account === account.gid);
      return {
        id: asAccountId(account.gid),
        name: account.name,
        broker: account.bank,
        brokerName: institutions.displayName(account.bank, lang),
        wrapper: parseAccountWrapper(settings.wrapper),
        currency: toCurrency(account.currency),
        importer: canonicalImporterId(settings.importer),
        hasMapping: Boolean(settings.mappingYaml),
        active: !account.removed,
        snapshotDate: latestPositionSnapshot(read, account.gid).asOf,
        lastImport:
          batch === undefined
            ? null
            : {
                batchId: asImportBatchId(batch.gid),
                at: storedTime(batch.createdAt),
                fileName: batch.fileName,
              },
      };
    });
}

const timeOrNull = (value: string | null) => (value === null ? null : storedTime(value));
function signalFacts(read: Read, rows: readonly SignalView[]): views.ViewSignal[] {
  const ranks = creationRanks(
    read,
    "signals",
    rows.map((row) => row.gid),
  );
  return rows.map((row) => ({
    id: row.gid,
    ruleId: row.ruleId,
    kind: row.kind,
    dedupKey: row.dedupKey,
    severity: parseSignalSeverity(row.severity),
    status: parseSignalStatus(row.status),
    polarity: row.polarity as SignalPolarity,
    message: row.message,
    payload: row.payload,
    instrumentId: row.instrument === null ? null : asInstrumentId(row.instrument),
    accountId: row.account === null ? null : asAccountId(row.account),
    firstSeenAt: storedTime(row.firstSeenAt),
    lastSeenAt: storedTime(row.lastSeenAt),
    snoozedUntil: timeOrNull(row.snoozedUntil),
    acknowledgedAt: timeOrNull(row.acknowledgedAt),
    closedAt: timeOrNull(row.closedAt),
    createdRun: row.createdRun,
    lastRun: row.lastRun,
    rank: rankOf(ranks, row.gid),
  }));
}
/** Internal projection inputs, including closed episodes; metadata ranks are never a DTO field. */
export function allSignalFacts(read: Read): readonly views.ViewSignal[] {
  return signalFacts(read, allSignals(read));
}

export type LiveReadFacts = views.ViewFacts;
export interface ReadFactsRequest {
  readonly portfolio: views.PortfolioViewState;
  readonly clock: views.ViewClock;
}
export function readFacts(read: Read, request: ReadFactsRequest): LiveReadFacts {
  const { portfolio, clock } = request;
  if (
    portfolio.snapshot.profileId !== portfolio.vault ||
    read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid !== portfolio.vault
  )
    throw new Error("invalid portfolio identity");
  const now = viewInstant(toStorage(clock.now));
  const signals = signalFacts(read, openSignals(read));
  const alertFacts: views.ViewAlert[] = byCreation(read, "alerts", alerts(read, clock.now)).map(
    (row) => ({
      id: row.gid,
      instrumentId: row.instrument === null ? null : asInstrumentId(row.instrument),
      kind: row.kind,
      params: row.params,
      polarity: row.polarity as SignalPolarity,
      title: row.title,
      source: row.source,
      status: row.status,
      severity: parseSignalSeverity(row.severity),
      lastTriggeredAt: timeOrNull(row.lastTriggeredAt),
      expiresAt: timeOrNull(row.expiresAt),
      snoozedUntil: timeOrNull(row.snoozedUntil),
      createdAt: storedTime(row.createdAt),
      updatedAt: storedTime(row.updatedAt),
    }),
  );
  const watched = byCreation(read, "watchlist", watchlist(read)).sort((a, b) =>
    a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0,
  );
  const watchedIds = new Set(watched.map((row) => row.instrument));
  const instruments = portfolio.instruments;
  const ids = [...instruments.keys()].sort();
  const health = healthByInstrument(read, ids, now);
  let oldestPlan: bigint | null = null;
  const prepared = new Map<
    InstrumentId,
    { held: ValuedHolding[]; plan: ReturnType<typeof effectivePlan> }
  >();
  const dated: InstrumentId[] = [];
  for (const inst of instruments.values()) {
    const held = portfolio.valued.valued.filter((row) => row.holding.instrumentId === inst.id);
    const plan = effectivePlan(inst.plan, {
      held: held.length > 0,
      planAt: inst.planAt,
      opened: openedOn(
        held.map((row) => row.holding),
        portfolio.snapshot.realized,
      ),
    });
    prepared.set(inst.id, { held, plan });
    // the opinion's time: the plan's when present, else the strength's (freshness reference)
    const opinionAt =
      (plan !== null ? inst.planAt : null) ??
      (inst.positionStrength !== null ? inst.strengthAt : null);
    if (opinionAt !== null) {
      dated.push(inst.id);
      const at = viewInstant(toStorage(opinionAt));
      if (oldestPlan === null || at < oldestPlan) oldestPlan = at;
    }
  }
  const notes: ResearchNote[] = [];
  if (oldestPlan !== null)
    for (let start = 0; start < dated.length; start += 500) {
      const chunk = dated.slice(start, start + 500);
      notes.push(
        ...noteRows(
          read,
          `n.instrument_id IN (SELECT id FROM view_ids WHERE gid IN (${marks(chunk.length)}))
      AND n.kind != ? AND (n.created_at > ? OR n.observed_at >= ?)`,
          [
            ...chunk,
            research.CANDIDATE_KIND,
            instantView(oldestPlan),
            instantView(now - BigInt(research.HEALTH_WINDOW_DAYS) * research.MICROS_PER_DAY),
          ],
        ),
      );
    }
  const ranks = noteRanks(read, notes);
  const subjects: views.AnnotationSubject[] = ids.map((id) => {
    const instrument = instruments.get(id);
    const found = health.get(id);
    if (instrument === undefined || found === undefined)
      throw new Error("missing canonical annotation facts");
    const subject = prepared.get(id);
    if (subject === undefined) throw new Error("missing prepared annotation facts");
    const { held, plan } = subject;
    const isHeld = held.length > 0;
    const weight = held.some((row) => row.weight === null)
      ? null
      : held.reduce((sum, row) => sum + (row.weight ?? 0), 0);
    return {
      instrument,
      held: isHeld,
      weight: isHeld ? weight : null,
      health: found.health,
      hasThesis: found.thesis !== undefined,
      hasExitPlan: (found.thesis?.exitPlan ?? "").trim().length > 0,
      thesisTracked: researchable(instrument),
      hintsWanted: isHeld || watchedIds.has(id),
      plan,
      planAt: plan === null ? null : instrument.planAt,
      positionStrength: instrument.positionStrength,
      strengthBasis: instrument.positionStrength === null ? null : instrument.strengthBasis,
      strengthAt: instrument.positionStrength === null ? null : instrument.strengthAt,
      coreChangedAt:
        found.thesis === undefined
          ? null
          : storedTime(found.thesis.coreChangedAt ?? found.thesis.updatedAt),
      notes:
        (plan === null || instrument.planAt === null) &&
        (instrument.positionStrength === null || instrument.strengthAt === null)
          ? []
          : notes
              .filter((row) => row.instrument === id)
              .map((row) => ({
                id: row.gid,
                scored: scoredNote(row, ranks.get(row.gid) as number),
              })),
      allOpenSignals: signals.filter((row) => row.instrumentId === id),
      hintTriggeredAlerts: alertFacts.filter(
        (row) => row.instrumentId === id && row.status === "triggered",
      ),
      freshnessTriggeredAlerts: alertFacts.filter(
        (row) => row.instrumentId === id && row.lastTriggeredAt !== null,
      ),
    };
  });
  const run = ruleRuns(read, 1)[0];
  const reportIds = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((id) => {
          if (typeof id !== "string") return [];
          const row = signalByGid(read, id);
          return row === undefined ? [] : [row.gid];
        })
      : [];
  return {
    clock,
    subjects,
    signals,
    alerts: alertFacts,
    watched: watched.map((row) => ({
      id: row.gid,
      instrumentId: asInstrumentId(row.instrument),
      note: row.note,
      tags: row.tags,
      source: row.source,
      addedAt: storedTime(row.addedAt),
    })),
    unread: new Map(
      [...unreadByInstrument(read, now)].map(([id, count]) => [asInstrumentId(id), count]),
    ),
    lastGoodRunId: lastGoodRunGid(read) ?? null,
    lastRun:
      run === undefined
        ? null
        : {
            id: run.gid,
            trigger: run.trigger,
            asOf: run.asOf,
            status: run.status,
            startedAt: storedTime(run.startedAt),
            finishedAt: timeOrNull(run.finishedAt),
            errors: run.errors.filter((error): error is string => typeof error === "string"),
            stats: run.stats,
            newSignalIds: reportIds(run.report.new),
            escalatedSignalIds: reportIds(run.report.escalated),
          },
  };
}
