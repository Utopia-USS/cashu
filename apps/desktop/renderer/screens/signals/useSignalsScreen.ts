import { D } from "@cashu/domain";
import { views } from "@cashu/domain/investments";
import { lang, normalizeNumberInput } from "@cashu/i18n";
import {
  conditionalOwnerAcknowledge,
  type InstrumentSearchResult,
  type ReadySignals,
  type SignalsWatchTarget,
  saveSignalGroup,
  signalsAlertCommands,
  signalsOwnerCommands,
  signalsQueries,
  signalsRemoveWatch,
  signalsSearch,
  signalsSnooze,
  signalsWatch,
} from "@cashu/store/investments/signals-screen";
import { useCommand, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { csvLine } from "@cashu/ui-logic/core/csv";
import { localDay } from "@cashu/ui-logic/core/time";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import {
  alertHistoryRows,
  alertSignalObserved,
  type SignalFilter,
  signalGroups,
} from "./presentation.js";
import { G } from "./Signals.strings.js";

const query = signalsQueries().screen;
const alerts = signalsAlertCommands();
export type SignalsPageKind = "alerts" | "watchlist" | "journal";
export type SignalsNotice =
  | "saved"
  | "skipped"
  | "partial"
  | "unknown"
  | "failed"
  | "cleanup"
  | "cache"
  | "watch_warning"
  | "removed"
  | "restored";
export interface SignalsScreenOptions {
  readonly page?: SignalsPageKind;
  readonly initialSignal?: string | null;
  readonly initialInstrument?: string | null;
  readonly onOpenAsset?: (gid: string) => void;
  readonly onOpenNote?: (
    note: string | null,
    instrument: string | null,
    segment: string | null,
  ) => void;
  readonly onOpenReview?: () => void;
  readonly onOpenPage?: (page: SignalsPageKind) => void;
  readonly onClose?: () => void;
  readonly onExportCsv?: (filename: string, content: string) => void;
}

type Signal = ReadySignals["signals"][number];
export function useSignalsScreen(options: SignalsScreenOptions = {}) {
  const { privacy } = useUiEnv();
  const today = useCalendarDay();
  const snapshot = useQuery(query, {
    // The open host supplies current time and a subscribed change source. This fallback is stable.
    now: "1970-01-01T00:00:00Z",
    today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    privacy,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<SignalFilter>("all");
  const [cursor, setCursor] = useState<string | null>(options.initialSignal ?? null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [notice, setNotice] = useState<SignalsNotice | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [undoIds, setUndoIds] = useState<readonly string[]>([]);
  const [undoSnooze, setUndoSnooze] = useState<string | null>(null);
  const [alertStatus, setAlertStatus] = useState("all");
  const [alertSource, setAlertSource] = useState("all");
  const [journalFilter, setJournalFilter] = useState<"all" | "decisions" | "signals">("all");
  const [journalInstrument, setJournalInstrument] = useState(options.initialInstrument ?? "");
  const [searchText, setSearchText] = useState("");
  const [searchResult, setSearchResult] = useState<InstrumentSearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [editingAlert, setEditingAlert] = useState<string | "new" | null>(null);
  const [removedWatch, setRemovedWatch] = useState<ReadySignals["watchlist"][number] | null>(null);
  const [removedAlert, setRemovedAlert] = useState<string | null>(null);
  const decide = useCommand(signalsOwnerCommands.decide);
  const positionDecision = useCommand(signalsOwnerCommands.positionDecision);
  const acknowledge = useCommand(conditionalOwnerAcknowledge);
  const undo = useCommand(signalsOwnerCommands.undo);
  const createAlert = useCommand(alerts.create);
  const updateAlert = useCommand(alerts.update);
  const deleteAlert = useCommand(signalsOwnerCommands.deleteAlert);
  const restoreAlert = useCommand(signalsOwnerCommands.restoreAlert);
  const searchAction = useUiAction(signalsSearch);
  const watchAction = useUiAction(signalsWatch);
  const removeWatchAction = useUiAction(signalsRemoveWatch);
  const snoozeAction = useUiAction(signalsSnooze);
  const data = snapshot.status === "ready" ? snapshot : null;
  const groups = data === null ? [] : signalGroups(data.open, data.held, filter);
  const selected = groups.find((group) => group.key === selectedGroup) ?? null;
  const openMembers = selected?.live ?? [];
  const selectedInstrument = selected?.instrument ?? null;
  const position =
    data?.context.status === "ready" && selectedInstrument !== null
      ? (data.context.positions.positions.find((row) => row.instrument.id === selectedInstrument) ??
        null)
      : null;
  const suggestion = views.decisionSuggestion({
    signal: openMembers[0] ?? null,
    position:
      position === null
        ? null
        : {
            quantity: position.quantity,
            price: position.price,
            priceCurrency: position.price_currency ?? position.instrument.currency,
          },
    total: data?.context.status === "ready" ? data.context.overview.kpis.value.total : D("0"),
    base: data?.context.status === "ready" ? data.context.overview.base_currency : "PLN",
  });
  const decisionForm = useForm({
    defaultValues: {
      action: "held",
      account: "",
      quantity: "",
      price: "",
      currency: "",
      reason: "",
    },
    onSubmit: async ({ value }) => {
      if (data === null || selected === null || inFlight.current || privacy) return;
      const members = selected.live;
      if (!members.length) return;
      inFlight.current = true;
      setBusy(true);
      setRefusal(null);
      setNotice(null);
      try {
        const fields = {
          action: value.action as "held" | "bought" | "sold" | "other",
          account: value.account || null,
          quantity: normalized(value.quantity),
          price: normalized(value.price),
          currency: value.currency || null,
          reason: value.reason.trim() || null,
        };
        if (selected.instrument !== null) {
          const result = await positionDecision.run({
            instrument: selected.instrument,
            signals: members.map((row) => row.gid),
            ...fields,
          });
          if (result.ok) {
            setUndoIds([result.value.decision]);
            setNotice("saved");
            setSelectedGroup(null);
          } else {
            setRefusal(result.reason);
            setNotice("failed");
          }
        } else {
          const [first, ...rest] = members;
          if (!first) return;
          const steps = [
            () => decide.run({ signal: first.gid, ...fields }),
            ...rest.map(
              (row) => () =>
                acknowledge.run({ signal: row.gid, reason: `decision: ${fields.action}` }),
            ),
          ];
          const outcome = await saveSignalGroup(steps, () => active.current);
          if (!active.current) return;
          setUndoIds(outcome.decisions);
          setNotice(
            outcome.status === "saved"
              ? "saved"
              : outcome.status === "skipped"
                ? "skipped"
                : outcome.status === "partial"
                  ? "partial"
                  : outcome.status === "unknown"
                    ? "unknown"
                    : "failed",
          );
          if (outcome.status === "refused" || outcome.status === "partial")
            setRefusal(outcome.reason);
          if (outcome.status === "saved" || outcome.status === "skipped") setSelectedGroup(null);
        }
      } catch {
        if (active.current) setNotice("unknown");
      } finally {
        inFlight.current = false;
        if (active.current) setBusy(false);
      }
    },
  });
  const decisionValues = useStore(decisionForm.store, (state) => state.values);
  const valuation = data?.context.status === "ready" ? data.context : null;
  const bucket = valuation?.allocation.buckets.find((row) => row.bucket_id === position?.bucket);
  const estimate =
    decisionValues.action === "bought" || decisionValues.action === "sold"
      ? views.decisionEstimate({
          side: decisionValues.action === "bought" ? "buy" : "sell",
          quantity: decimalOrNull(decisionValues.quantity),
          price: decimalOrNull(decisionValues.price),
          currency: decisionValues.currency || suggestion.currency,
          base: valuation?.overview.base_currency ?? "PLN",
          total: valuation?.overview.kpis.value.total ?? D("0"),
          bucket:
            bucket === undefined
              ? null
              : {
                  value: bucket.value,
                  target: bucket.target,
                  driftPp: bucket.drift_pp,
                  generic: bucket.generic,
                },
        })
      : null;
  useEffect(() => {
    if (selected === null) return;
    decisionForm.reset({
      action:
        suggestion.choice === "buy"
          ? "bought"
          : suggestion.choice === "sell"
            ? "sold"
            : suggestion.choice === "later"
              ? "other"
              : "held",
      account: "",
      quantity: suggestion.quantity?.toString() ?? "",
      price: suggestion.price?.toString() ?? "",
      currency: suggestion.currency,
      reason: "",
    });
  }, [selectedGroup]);
  useEffect(() => {
    if (privacy) {
      setSearchResult(null);
      setSearchText("");
      setEditingAlert(null);
      setSelectedGroup(null);
      setUndoIds([]);
    }
  }, [privacy]);
  useEffect(() => {
    if (!searchText.trim() || privacy) {
      setSearchResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setSearchBusy(true);
      void searchAction
        .run({ query: searchText })
        .then((result) => {
          if (live && result.status === "completed" && result.value.query === searchText.trim())
            setSearchResult(result.value);
        })
        .finally(() => {
          if (live) setSearchBusy(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [searchText, privacy]);
  const run = async (
    action: () => Promise<
      { ok: true; value: { decision: string } } | { ok: false; reason: string }
    >,
  ) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await action();
      if (result.ok) {
        setUndoIds([result.value.decision]);
        setNotice("saved");
      } else {
        setRefusal(result.reason);
        setNotice("failed");
      }
    } catch {
      setNotice("unknown");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const acknowledgeGroup = (key: string) => {
    const group = groups.find((row) => row.key === key);
    if (!group || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void saveSignalGroup(
      group.live.map((row) => () => acknowledge.run({ signal: row.gid, reason: null })),
      () => active.current,
    )
      .then((result) => {
        if (!active.current) return;
        setUndoIds(result.decisions);
        setNotice(
          result.status === "saved"
            ? "saved"
            : result.status === "skipped"
              ? "skipped"
              : result.status === "partial"
                ? "partial"
                : result.status === "unknown"
                  ? "unknown"
                  : "failed",
        );
        if (result.status === "partial" || result.status === "refused") setRefusal(result.reason);
      })
      .finally(() => {
        inFlight.current = false;
        if (active.current) setBusy(false);
      });
  };
  const undoDecisions = async () => {
    if (inFlight.current || !undoIds.length) return;
    inFlight.current = true;
    setBusy(true);
    const remaining = [...undoIds];
    try {
      for (const id of undoIds) {
        if (!active.current) break;
        const result = await undo.run({ decision: id });
        if (!active.current) break;
        if (!result.ok) {
          setRefusal(result.reason);
          break;
        }
        remaining.shift();
      }
      if (active.current) {
        setUndoIds(remaining);
        setNotice(remaining.length ? "partial" : "saved");
      }
    } catch {
      if (active.current) setNotice("unknown");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const undoOne = async (decision: string) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await undo.run({ decision });
      if (result.ok) {
        setUndoIds((old) => old.filter((id) => id !== decision));
        setNotice("saved");
      } else {
        setRefusal(result.reason);
        setNotice("failed");
      }
    } catch {
      setNotice("unknown");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const snooze = async (signal: string, until: string | null) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await snoozeAction.run({ signal, until });
      if (result.status === "completed") {
        setUndoSnooze(until === null ? null : signal);
        setNotice(result.value.status === "saved" ? "saved" : "cleanup");
      } else if (result.status === "outcome_unknown") setNotice("unknown");
      else {
        setRefusal(result.status === "refused" ? result.reason : result.reason);
        setNotice("failed");
      }
    } catch {
      setNotice("unknown");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const addWatch = async (
    target: SignalsWatchTarget,
    note?: string | null,
    tags?: readonly string[] | null,
  ) => {
    if (inFlight.current || privacy) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await watchAction.run({
        target,
        ...(note === undefined ? {} : { note }),
        ...(tags === undefined ? {} : { tags }),
      });
      if (result.status === "completed" && result.value.ok) {
        setSearchText("");
        setSearchResult(null);
        setNotice(
          result.value.value.cacheStatus === "unconfirmed"
            ? "cache"
            : result.value.value.warnings.length
              ? "watch_warning"
              : "saved",
        );
        return true;
      } else if (result.status === "outcome_unknown") setNotice("unknown");
      else {
        setRefusal(
          result.status === "completed" && !result.value.ok
            ? result.value.reason
            : result.status === "completed"
              ? "unexpected_result"
              : result.reason,
        );
        setNotice("failed");
      }
      return false;
    } catch {
      setNotice("unknown");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const removeWatch = async (item: ReadySignals["watchlist"][number]) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await removeWatchAction.run({ item: item.gid });
      if (result.status === "completed") {
        setRemovedWatch(item);
        setNotice("removed");
      } else if (result.status === "outcome_unknown") setNotice("unknown");
      else {
        setRefusal(result.reason);
        setNotice("failed");
      }
    } catch {
      setNotice("unknown");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const restoreWatch = async () => {
    if (removedWatch === null) return;
    const saved = await addWatch(
      { kind: "instrument", gid: removedWatch.instrument },
      removedWatch.note,
      removedWatch.tags,
    );
    if (saved) setRemovedWatch(null);
  };
  const runAlertWrite = async (
    write: () => Promise<{ ok: true } | { ok: false; reason: string }>,
    onSaved: () => void,
  ) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await write();
      if (!active.current) return;
      if (result.ok) {
        onSaved();
      } else {
        setRefusal(result.reason);
        setNotice("failed");
      }
    } catch {
      if (active.current) setNotice("unknown");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const saveAlert = (input: { alert: string | null; fields: Record<string, unknown> }) =>
    runAlertWrite(
      () =>
        input.alert === null
          ? createAlert.run(input.fields as Parameters<typeof createAlert.run>[0])
          : updateAlert.run({ alert: input.alert, changes: input.fields }),
      () => {
        setEditingAlert(null);
        setNotice("saved");
      },
    );
  const removeAlert = async (alert: string) => {
    await runAlertWrite(
      () => deleteAlert.run({ alert }),
      () => {
        setRemovedAlert(alert);
        setNotice("removed");
      },
    );
  };
  const restoreDeletedAlert = async () => {
    if (removedAlert === null) return;
    await runAlertWrite(
      () => restoreAlert.run({ alert: removedAlert }),
      () => {
        setRemovedAlert(null);
        setNotice("restored");
      },
    );
  };
  const setAlertState = async (alert: string, status: "active" | "muted") => {
    await runAlertWrite(
      () => updateAlert.run({ alert, changes: { status } }),
      () => {
        setNotice("saved");
      },
    );
  };
  const shownAlerts =
    data?.alerts.filter(
      (row) =>
        (alertStatus === "all" || row.status === alertStatus) &&
        (alertSource === "all" || row.source === alertSource),
    ) ?? [];
  const journal =
    data?.signals.filter(
      (row) => journalInstrument === "" || row.instrument === journalInstrument,
    ) ?? [];
  const journalDecisions =
    data?.decisions.filter(
      (row) => journalInstrument === "" || row.instrument === journalInstrument,
    ) ?? [];
  const history = data === null ? [] : alertHistoryRows(data.signals, data.asOf);
  const exportHistory = () => {
    if (privacy || data === null) return;
    const byAlert = new Map(data.alerts.map((row) => [row.gid, row]));
    const lines = [
      csvLine([G.csvDate, G.csvTitle, G.csvValue, G.polarity, G.source, G.csvNext, G.csvDecision]),
      ...history.map((row) => {
        const alert = row.alert === null ? null : (byAlert.get(row.alert) ?? null);
        return csvLine([
          localDay(row.firstSeenAt) ?? "",
          alert?.title ?? String(row.payload.title ?? row.instrumentLabel ?? row.message),
          alertSignalObserved(row)?.value ?? "",
          row.polarity,
          alert?.source ?? G.deletedAlert,
          row.status,
          row.decisions.at(-1)?.action ?? "",
        ]);
      }),
    ];
    options.onExportCsv?.(G.csvFile, `\uFEFF${lines.join("\n")}`);
  };
  const next =
    data?.context.status === "ready" ? nextDeposit(today, data.context.contributionDay) : null;
  return {
    data,
    privacy,
    today,
    groups,
    dialogOpen,
    setDialogOpen,
    filter,
    setFilter,
    cursor,
    setCursor,
    selectedGroup,
    setSelectedGroup,
    selected,
    decisionForm,
    decisionValues,
    suggestion,
    estimate,
    busy,
    notice,
    refusal,
    undoIds,
    undoDecisions,
    undoOne,
    undoSnooze,
    snooze,
    acknowledgeGroup,
    run,
    next,
    alertStatus,
    setAlertStatus,
    alertSource,
    setAlertSource,
    shownAlerts,
    editingAlert,
    setEditingAlert,
    saveAlert,
    removeAlert,
    restoreDeletedAlert,
    removedAlert,
    setAlertState,
    history,
    exportHistory,
    journal,
    journalDecisions,
    journalFilter,
    setJournalFilter,
    journalInstrument,
    setJournalInstrument,
    searchText,
    setSearchText,
    searchResult,
    searchBusy,
    addWatch,
    removeWatch,
    restoreWatch,
    removedWatch,
    options,
  };
}
function normalized(text: string): string | null {
  const result = normalizeNumberInput(text);
  return result.trim() ? result : null;
}
function decimalOrNull(text: string) {
  try {
    const value = normalized(text);
    return value === null ? null : D(value);
  } catch {
    return null;
  }
}
export type SignalsScreenState = ReturnType<typeof useSignalsScreen>;
export type SignalRow = Signal;
