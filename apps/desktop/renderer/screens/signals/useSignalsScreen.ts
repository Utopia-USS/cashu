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
import { isStale, useCommand, useConnection, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { csvLine } from "@cashu/ui-logic/core/csv";
import { localDay } from "@cashu/ui-logic/core/time";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { type GuardedOutcome, useDurableCommands } from "../useDurableCommand.js";
import { notificationSignalGroup } from "./notificationFocus.js";
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
  | "unavailable"
  | "previous_completed"
  | "previous_refused"
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
let displayClockDay = "";
let displayClockNow = "";
/** Stable across React's first-render Suspense retries; the host's clock overrides this read-only fallback. */
function displayClock(day: string): string {
  if (day !== displayClockDay) {
    displayClockDay = day;
    displayClockNow = new Date().toISOString();
  }
  return displayClockNow;
}
function decisionDefaults(action: string, quantity: string, price: string, currency: string) {
  return { action, account: "", quantity, price, currency, reason: "" };
}
export function useSignalsScreen(options: SignalsScreenOptions = {}) {
  const { privacy } = useUiEnv();
  const connection = useConnection();
  const today = useCalendarDay();
  const displayNow = displayClock(today);
  const snapshot = useQuery(query, {
    // The host's live clock wins when bound; a local day-scoped read clock keeps native displays
    // usable before that provider is installed. It never grants write or fetch authority.
    now: displayNow,
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
  const changeSearchText = (value: string) => {
    setSearchResult(null);
    setSearchBusy(false);
    setSearchText(value);
  };
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
  const durable = useDurableCommands();
  const searchAction = useUiAction(signalsSearch);
  const watchAction = useUiAction(signalsWatch);
  const removeWatchAction = useUiAction(signalsRemoveWatch);
  const snoozeAction = useUiAction(signalsSnooze);
  const data = snapshot.status === "ready" ? snapshot : null;
  const focusedSignal = useRef<string | null>(null);
  useEffect(() => {
    const signalId = options.initialSignal;
    if (signalId === undefined || signalId === null) {
      focusedSignal.current = null;
      return;
    }
    if (data === null || privacy || isStale(connection)) return;
    if (focusedSignal.current === signalId) return;
    focusedSignal.current = signalId;
    const group = notificationSignalGroup(data, signalId);
    setFilter("all");
    setCursor(group === null ? null : signalId);
    setSelectedGroup(group);
  }, [options.initialSignal, data, privacy, connection]);
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
  const selectedKey = selected?.key ?? null;
  const suggestedAction =
    suggestion.choice === "buy"
      ? "bought"
      : suggestion.choice === "sell"
        ? "sold"
        : suggestion.choice === "later"
          ? "other"
          : "held";
  const suggestedQuantity = suggestion.quantity?.toString() ?? "";
  const suggestedPrice = suggestion.price?.toString() ?? "";
  const decisionForm = useForm({
    defaultValues: decisionDefaults(
      suggestedAction,
      suggestedQuantity,
      suggestedPrice,
      suggestion.currency,
    ),
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
          const result = await durable.run(`position:${selected.key}`, positionDecision, {
            instrument: selected.instrument,
            signals: members.map((row) => row.gid),
            ...fields,
          });
          if (result.kind === "completed") {
            setUndoIds([result.value.decision]);
            setNotice("saved");
            setSelectedGroup(null);
          } else {
            if (result.kind === "refused") setRefusal(result.reason);
            setNotice(
              result.kind === "outcome_unknown"
                ? "unknown"
                : result.kind === "not_started"
                  ? "unavailable"
                  : result.kind === "previous_completed" || result.kind === "previous_refused"
                    ? result.kind
                    : "failed",
            );
          }
        } else {
          const [first, ...rest] = members;
          if (!first) return;
          const steps = [
            () => durable.run(`decide:${first.gid}`, decide, { signal: first.gid, ...fields }),
            ...rest.map(
              (row) => () =>
                durable.run(`ack:${row.gid}`, acknowledge, {
                  signal: row.gid,
                  reason: `decision: ${fields.action}`,
                }),
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
                    : outcome.status === "unavailable" ||
                        outcome.status === "previous_completed" ||
                        outcome.status === "previous_refused"
                      ? outcome.status
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
  const initializedGroup = useRef<string | null>(null);
  useEffect(() => {
    if (selectedKey === null) {
      initializedGroup.current = null;
      return;
    }
    if (initializedGroup.current === selectedKey) return;
    initializedGroup.current = selectedKey;
    decisionForm.reset(
      decisionDefaults(suggestedAction, suggestedQuantity, suggestedPrice, suggestion.currency),
    );
  }, [
    selectedKey,
    decisionForm,
    suggestedAction,
    suggestedQuantity,
    suggestedPrice,
    suggestion.currency,
  ]);
  const searchRun = useRef(searchAction.run);
  useLayoutEffect(() => {
    searchRun.current = searchAction.run;
  }, [searchAction.run]);
  useEffect(() => {
    if (!searchText.trim() || privacy) return;
    let live = true;
    const timer = setTimeout(() => {
      setSearchBusy(true);
      void searchRun
        .current({ query: searchText })
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
  const run = async (action: () => Promise<GuardedOutcome<{ decision: string }>>) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await action();
      if (result.kind === "completed") {
        setUndoIds([result.value.decision]);
        setNotice("saved");
      } else {
        if (result.kind === "refused") setRefusal(result.reason);
        setNotice(
          result.kind === "outcome_unknown"
            ? "unknown"
            : result.kind === "not_started"
              ? "unavailable"
              : result.kind === "previous_completed" || result.kind === "previous_refused"
                ? result.kind
                : "failed",
        );
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
      group.live.map(
        (row) => () =>
          durable.run(`ack:${row.gid}`, acknowledge, { signal: row.gid, reason: null }),
      ),
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
                  : result.status === "unavailable" ||
                      result.status === "previous_completed" ||
                      result.status === "previous_refused"
                    ? result.status
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
        const result = await durable.run(`undo:${id}`, undo, { decision: id });
        if (!active.current) break;
        if (result.kind !== "completed") {
          if (result.kind === "refused") setRefusal(result.reason);
          setNotice(
            result.kind === "outcome_unknown"
              ? "unknown"
              : result.kind === "not_started"
                ? "unavailable"
                : result.kind === "previous_completed" || result.kind === "previous_refused"
                  ? result.kind
                  : "failed",
          );
          break;
        }
        remaining.shift();
      }
      if (active.current) {
        setUndoIds(remaining);
        if (remaining.length === 0) setNotice("saved");
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
      const result = await durable.run(`undo:${decision}`, undo, { decision });
      if (result.kind === "completed") {
        setUndoIds((old) => old.filter((id) => id !== decision));
        setNotice("saved");
      } else {
        if (result.kind === "refused") setRefusal(result.reason);
        setNotice(
          result.kind === "outcome_unknown"
            ? "unknown"
            : result.kind === "not_started"
              ? "unavailable"
              : result.kind === "previous_completed" || result.kind === "previous_refused"
                ? result.kind
                : "failed",
        );
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
        changeSearchText("");
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
    write: () => Promise<GuardedOutcome<unknown>>,
    onSaved: () => void,
  ) => {
    if (inFlight.current || privacy) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await write();
      if (!active.current) return;
      if (result.kind === "completed") {
        onSaved();
      } else {
        if (result.kind === "refused") setRefusal(result.reason);
        setNotice(
          result.kind === "outcome_unknown"
            ? "unknown"
            : result.kind === "not_started"
              ? "unavailable"
              : result.kind === "previous_completed" || result.kind === "previous_refused"
                ? result.kind
                : "failed",
        );
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
          ? durable.run(
              "alert-create",
              createAlert,
              input.fields as Parameters<typeof createAlert.run>[0],
            )
          : durable.run(`alert-update:${input.alert}`, updateAlert, {
              alert: input.alert,
              changes: input.fields,
            }),
      () => {
        setEditingAlert(null);
        setNotice("saved");
      },
    );
  const removeAlert = async (alert: string) => {
    await runAlertWrite(
      () => durable.run(`alert-delete:${alert}`, deleteAlert, { alert }),
      () => {
        setRemovedAlert(alert);
        setNotice("removed");
      },
    );
  };
  const restoreDeletedAlert = async () => {
    if (removedAlert === null) return;
    await runAlertWrite(
      () => durable.run(`alert-restore:${removedAlert}`, restoreAlert, { alert: removedAlert }),
      () => {
        setRemovedAlert(null);
        setNotice("restored");
      },
    );
  };
  const setAlertState = async (alert: string, status: "active" | "muted") => {
    await runAlertWrite(
      () => durable.run(`alert-update:${alert}`, updateAlert, { alert, changes: { status } }),
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
    displayNow,
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
    setSearchText: changeSearchText,
    searchResult: privacy || searchResult?.query !== searchText.trim() ? null : searchResult,
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
