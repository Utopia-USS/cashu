// The screen hook of the ported decision journal (ab24ab6 v2/Journal.tsx): the reads (all signals, the decisions,
// the instrument names), the Wszystko / Decyzje / Sygnały filter, one instrument, the page size, the 15-minute
// undo of a decision and the year's facts.
import { intlLocale } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/Journal.strings";
import { useToast } from "@cashu/ui";
import { localDay, parseServerTime } from "@cashu/ui-logic/core/time";
import { DECISION_ACTION } from "@cashu/ui-logic/investments/labels";
import type { Decision } from "@cashu/ui-logic/investments/types";
import {
  groupByMonth,
  type JournalFilter,
  journalEntries,
  journalStats,
} from "@cashu/ui-logic/investments/v2/logic";
import { useState } from "react";
import { gidOf, legacyIdOf } from "../investments/home/legacyWire.js";
import type { JournalProps } from "./JournalView.js";
import { historyLine, recordRow } from "./journalModel.js";
import { makeUndo, type Undo, undoMessage, undoSettled } from "./legacy/undo.js";
import { useLegacySignalsApi } from "./useLegacySignalsApi.js";
import { useSignalsPageReads } from "./useSignalsPageReads.js";

const PAGE = 40;
/** The undo's saved-at fallback for a decision without a timestamp (old `|| Date.now()`). */
const nowMs = () => Date.now();

export interface JournalInput {
  /** `?instrument=<gid>` from the asset page's `dziennik` link. */
  initialInstrument?: string | null;
  onBack(): void;
  onOpenAsset(gid: string): void;
}

export function useJournal(o: JournalInput): JournalProps {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const reads = useSignalsPageReads();
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [only, setOnly] = useState<string>(() => {
    const id = legacyIdOf(o.initialInstrument);
    return id == null ? "" : String(id);
  });
  const [shown, setShown] = useState(PAGE);
  const [undos] = useState(() => new Map<number, Undo>());
  const today = reads.today;
  const year = today.slice(0, 4);

  const names = new Map<number, string>(reads.instruments.map((i) => [i.id, i.label]));
  for (const s of reads.signals.data ?? [])
    if (s.instrument_id != null && !names.has(s.instrument_id) && s.instrument_label)
      names.set(s.instrument_id, s.instrument_label);
  const choices = [...names].sort((a, b) => a[1].localeCompare(b[1], intlLocale()));
  const signals = reads.signals.data ?? [];
  const decisions = reads.decisions ?? [];
  const entries = journalEntries(signals, decisions, filter, only || null);
  const stats = journalStats(signals, decisions, year);
  const groups = groupByMonth(
    entries.slice(0, shown).map((e) => ({ ...e, date: localDay(e.at) ?? e.at.slice(0, 10) })),
    today,
  );
  const sigRows = signals
    .filter((s) => !only || String(s.instrument_id) === only)
    .sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));

  const undo = (d: Decision) => {
    let u = undos.get(d.id);
    if (!u) {
      u = makeUndo(parseServerTime(d.created_at) || nowMs(), () => api.deleteDecision(d.id));
      undos.set(d.id, u);
    }
    void u.undo().then((res) => {
      const msg = undoMessage(res, S.decisionNoun);
      if (msg) toast(msg, res === "failed" ? 6000 : 3000);
      if (undoSettled(res)) undos.delete(d.id);
    });
  };
  const cb = {
    names,
    onOpenAsset: (id: number) => {
      const gid = gidOf(id);
      if (gid !== null) o.onOpenAsset(gid);
    },
    onUndo: undo,
  };
  const loading = !reads.signals.data || !reads.decisions;
  const acts = Object.entries(stats.byAction)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${n} × ${DECISION_ACTION[a] ?? a}`)
    .join(" · ");
  const accName = (id: number | null) =>
    id == null ? null : (reads.accounts.find((a) => a.id === id)?.name ?? null);
  const withAccount = sigRows.some((s) => accName(s.account_id));
  return {
    crumb: {
      label: S.breadcrumb,
      items: [{ label: S.investments, onPress: o.onBack }, { label: S.journal }],
    },
    title: S.journal,
    filter: {
      label: S.show,
      value: filter,
      onChange: (v) => {
        setFilter(v);
        setShown(PAGE);
      },
      items: [
        [S.all, "all"],
        [S.decisions, "decisions"],
        [S.signals, "signals"],
      ],
    },
    instrument: {
      label: "Instrument",
      value: only,
      onChange: (v) => {
        setOnly(v);
        setShown(PAGE);
      },
      options: [
        { value: "", label: S.allInstruments },
        ...choices.map(([id, label]) => ({ value: String(id), label })),
      ],
    },
    error: reads.signals.error ? S.error(String(reads.signals.error)) : null,
    loading,
    record: {
      title: S.record,
      count: loading ? null : entries.length || null,
      empty: entries.length ? null : filter === "decisions" ? S.noDecisions : S.noEntries,
      groups: groups.map((g) => ({
        key: g.key,
        label: g.label,
        rows: g.items.flatMap((e, k) => {
          const r = recordRow(e, k, cb);
          return r ? [r] : [];
        }),
      })),
      more:
        entries.length > shown
          ? {
              label: S.showMore(Math.min(PAGE, entries.length - shown)),
              onPress: () => setShown((n) => n + PAGE),
            }
          : null,
    },
    stats: {
      title: S.inNumbers(year),
      facts: [
        { label: S.decisions, value: String(stats.decisions), detail: acts || null },
        {
          label: S.signals,
          value: String(stats.signals),
          detail: S.decidedExpired(stats.decided, stats.expired),
        },
        {
          label: S.timeToDecision,
          value:
            stats.medianDays == null
              ? "-"
              : stats.medianDays < 1
                ? S.underDay
                : S.days(Math.round(stats.medianDays)),
          detail: S.medianFromSignal,
        },
        {
          label: S.noDecision,
          value: stats.signals ? S.pctInt(Math.round((stats.expired / stats.signals) * 100)) : "-",
          detail: S.signalsExpired,
        },
      ],
    },
    history: {
      title: S.history,
      count: loading ? null : sigRows.length || null,
      empty: sigRows.length ? null : S.noSignals,
      head: [
        S.thSince,
        S.thSignal,
        S.thType,
        S.thStatus,
        S.thDecision,
        ...(withAccount ? [S.thAccount] : []),
      ],
      withAccount,
      rows: sigRows.slice(0, 200).map((s) => historyLine(s, cb, accName)),
    },
  };
}
