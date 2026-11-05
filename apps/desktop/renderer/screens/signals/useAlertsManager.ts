// The screen hook of the ported alerts manager (ab24ab6 v2/Alerts.tsx AlertsManager + removeAlertWithUndo +
// TriggeredHistory): the filters, the edited alert, mute / unmute / delete with the restore undo, the table and
// history rows and the CSV export; and alertFormProps, the props of the form from its state (useAlertForm).
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/Alerts.strings";
import { useToast } from "@cashu/ui";
import { bucketLabel as bucketName, dm, dmy, hm, pct } from "@cashu/ui-logic/investments/labels";
import { orderAlerts, price } from "@cashu/ui-logic/investments/v2/logic";
import type { Alert } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import { legacyIdOf } from "../investments/home/legacyWire.js";
import type { AlertFormProps, AlertsManagerProps, FieldCell } from "./AlertsManagerView.js";
import {
  alertTableRow,
  CARDS,
  COOLDOWNS,
  cardLabel,
  cooldownLabel,
  expiryChoices,
  historyCsv,
  historyRows,
  historySignals,
  isLive,
  type SourceFilter,
  STATIC_KINDS,
  type StatusFilter,
} from "./alertsModel.js";
import { useInFlight } from "./legacy/inflight.js";
import { errorText } from "./legacy/outcome.js";
import type { AlertFormState } from "./useAlertForm.js";
import { useLegacySignalsApi } from "./useLegacySignalsApi.js";
import { removeAlertWithUndo } from "./useRemoveAlert.js";
import { useSignalsPageReads } from "./useSignalsPageReads.js";

export interface AlertsManagerInput {
  /** `?instrument=<gid>`: the new alert's instrument. */
  initialInstrument?: string | null;
  /** `?edit=<gid>`: the alert in the form (else the form is a new alert, old `?new=1` included). */
  initialEdit?: string | null;
  /** The crumb's `Inwestycje` (back to the Home). */
  onBack(): void;
  onExportCsv(filename: string, content: string): void;
}

export function useAlertsManager(o: AlertsManagerInput) {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const reads = useSignalsPageReads();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [editing, setEditingState] = useState<number | "new">(
    () => legacyIdOf(o.initialEdit) ?? "new",
  );
  // A new key per opened form: after a save the "new" form starts empty again.
  const [formKey, setFormKey] = useState(0);
  const setEditing = (v: number | "new") => {
    setEditingState(v);
    setFormKey((k) => k + 1);
  };
  const flight = useInFlight();
  const all = reads.alerts.data ?? [];
  const count = (st: string) => all.filter((a) => a.status === st).length;
  const agentCount = all.filter((a) => a.source === "agent").length;
  const list = orderAlerts(
    all.filter(
      (a) =>
        (status === "all" || a.status === status) &&
        (source === "all" || (source === "agent" ? a.source === "agent" : a.source !== "agent")),
    ),
  );
  const lastCheck =
    all
      .map((a) => a.last_checked_at)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] ?? null;
  const agentLive = all.filter((a) => a.source === "agent" && isLive(a)).length;
  const editAlert =
    typeof editing === "number" ? (all.find((a) => a.id === editing) ?? null) : null;

  // One mute / delete request at a time (F7 FE2): a double click must not send a second delete.
  const act = (a: Alert, what: "mute" | "unmute" | "delete") =>
    flight.run(async () => {
      try {
        if (what === "delete") {
          if ((await removeAlertWithUndo(api, a, toast)) && editing === a.id) setEditing("new");
          return;
        }
        await api.patchAlert(a.id, { status: what === "mute" ? "muted" : "active" });
        toast(what === "mute" ? S.muted : S.unmuted, 2500);
      } catch (e) {
        toast(S.saveFailed(errorText(e)), 5000);
      }
    });

  // History that never loaded reads as empty (the old fallback).
  const histList = reads.signals.data ?? (reads.signals.error ? [] : null);
  const hist = histList ? historySignals(histList, Date.parse(`${reads.today}T12:00:00`)) : [];
  const view: Omit<AlertsManagerProps, "form"> = {
    crumb: {
      label: S.breadcrumb,
      items: [{ label: S.investments, onPress: o.onBack }, { label: S.alerts }],
    },
    title: S.alerts,
    status: {
      label: S.status,
      value: status,
      onChange: setStatus,
      items: [
        [S.waitingN(count("active")), "active"],
        [S.metN(count("triggered")), "triggered"],
        [S.snoozedN(count("snoozed")), "snoozed"],
        [S.mutedN(count("muted")), "muted"],
        [S.all, "all"],
      ],
    },
    source: {
      label: S.source,
      value: source,
      onChange: setSource,
      items: [
        [S.all, "all"],
        [S.mine, "user"],
        [S.agentN(agentCount), "agent"],
      ],
    },
    checked: lastCheck ? S.checked(dm(lastCheck), hm(lastCheck)) : "",
    list: {
      label: S.listLabel,
      loading: !reads.alerts.data,
      empty: list.length ? null : S.noAlerts,
      head: {
        status: S.status,
        alert: S.colAlert,
        scope: S.colScope,
        nowLevel: S.colNowLevel,
        type: S.colType,
        source: S.colSource,
        last: S.colLast,
        actions: S.colActions,
      },
      rows: list.map((a) => ({
        ...alertTableRow(a),
        you: S.you,
        agentText: "agent",
        mute:
          a.status === "muted"
            ? {
                glyph: "●",
                label: S.turnOnAria(a.title),
                title: S.turnOn,
                onPress: () => void act(a, "unmute"),
              }
            : {
                glyph: "◌",
                label: S.muteAria(a.title),
                title: S.mute,
                onPress: () => void act(a, "mute"),
                disabled: a.status === "expired",
              },
        edit: { label: S.editAria(a.title), title: C.edit, onPress: () => setEditing(a.id) },
        remove: {
          label: S.removeAria(a.title),
          title: C.remove,
          onPress: () => void act(a, "delete"),
          disabled: flight.busy,
        },
      })),
      foot: {
        count: String(all.length),
        word: S.alertsWord(all.length),
        limit: S.agentLimit,
        limitValue: S.xOf50(agentLive),
      },
    },
    history: {
      title: S.history,
      count: S.historyCount(hist.length),
      loading: !histList,
      empty: hist.length ? null : S.noneMet,
      exportCsv: hist.length
        ? { label: S.exportCsv, onPress: () => o.onExportCsv(S.csvFile, historyCsv(hist, all)) }
        : null,
      head: [S.colDate, S.colAlert, S.colValue, S.colType, S.colSource, S.colNext, S.colDecision],
      you: S.you,
      agent: "agent",
      deleted: S.deleted,
      rows: historyRows(hist, all),
    },
  };
  const presetInstrument =
    editing === "new" && formKey === 0 ? legacyIdOf(o.initialInstrument) : null;
  return {
    view,
    form: {
      key: `${editing}:${formKey}`,
      api,
      alert: editAlert,
      instruments: reads.instruments,
      buckets: reads.buckets,
      digestWeekday: reads.digestWeekday,
      catalog: reads.catalog ?? STATIC_KINDS,
      presetInstrument,
      onCancel: () => setEditing("new"),
      onSaved: (title: string, created: boolean) => {
        toast(created ? S.created(title) : S.savedAlert, 2500);
        setEditing("new");
      },
    },
  };
}

/** The form's props from its state (old AlertForm render). */
export function alertFormProps(
  st: AlertFormState,
  o: {
    buckets: string[];
    instruments: { id: number }[];
    instrumentList: string[];
    onCancel(): void;
  },
): AlertFormProps {
  const { alert, f, kind, inst } = st;
  const seg = <T extends string>(
    label: string,
    value: T,
    items: [string, T][],
    onChange: (v: T) => void,
    extra: { disabled?: boolean; title?: string; ariaLabel?: string } = {},
  ) => ({ label, value, items, onChange, ...extra });
  const segCell = (field: AlertFormProps["polarity"]): FieldCell => ({ kind: "seg", field });
  const input = (field: Extract<FieldCell, { kind: "input" }>["field"]): FieldCell => ({
    kind: "input",
    field,
  });
  const win = input({
    id: "af-win",
    label: S.window,
    value: f.windowDays,
    num: true,
    inputMode: "numeric",
    onChange: (v) => st.update({ windowDays: v.replace(/\D/g, "") }),
  });
  const rows: AlertFormProps["rows"] = [];
  if (kind === "price_above" || kind === "price_below")
    rows.push({
      kind: "pair",
      cells: [
        input({
          id: "af-level",
          label: `${S.level}${inst ? ` (${inst.currency})` : ""}`,
          value: f.level,
          num: true,
          inputMode: "decimal",
          onChange: (v) => st.update({ level: v }),
        }),
        input({
          id: "af-now",
          label: S.nowLabel,
          disabled: true,
          onChange: () => {},
          value:
            inst?.price != null
              ? `${price(inst.price, inst.currency)}${st.distNow != null ? ` · ${pct(st.distNow, true)}` : ""}`
              : "-",
        }),
      ],
    });
  if (
    kind === "change_pct" ||
    kind === "drawdown_from_high" ||
    kind === "new_high" ||
    kind === "sma_cross"
  )
    rows.push({
      kind: "pair",
      cells: [
        win,
        ...(kind === "change_pct" || kind === "drawdown_from_high"
          ? [
              input({
                id: "af-th",
                label: S.thresholdPct,
                value: f.threshold,
                num: true,
                inputMode: "decimal",
                onChange: (v) => st.update({ threshold: v }),
              }),
            ]
          : []),
        ...(kind === "sma_cross"
          ? [
              segCell(
                seg(
                  S.direction,
                  f.direction,
                  [
                    [S.down, "below"],
                    [S.up, "above"],
                  ],
                  (v) => st.update({ direction: v }),
                ),
              ),
            ]
          : []),
      ],
    });
  if (kind === "range_breakout" || kind === "volume_spike")
    rows.push({
      kind: "pair",
      cells: [
        win,
        kind === "range_breakout"
          ? input({
              id: "af-range",
              label: S.maxRange,
              value: f.rangePct ?? "",
              num: true,
              inputMode: "decimal",
              onChange: (v) => st.update({ rangePct: v }),
            })
          : input({
              id: "af-mult",
              label: S.multiple,
              value: f.multiple ?? "",
              num: true,
              inputMode: "decimal",
              onChange: (v) => st.update({ multiple: v }),
            }),
      ],
    });
  if (kind === "range_breakout")
    rows.push({
      kind: "one",
      cell: segCell(
        seg(
          S.direction,
          f.direction,
          [
            [S.up, "up"],
            [S.down, "down"],
            [S.both, "any"],
          ],
          (v) => st.update({ direction: v }),
          {
            ariaLabel: S.breakoutDirection,
          },
        ),
      ),
    });
  if (kind === "change_pct")
    rows.push({
      kind: "one",
      cell: segCell(
        seg(
          S.direction,
          f.direction,
          [
            [S.fall, "down"],
            [S.rise, "up"],
            [S.both, "any"],
          ],
          (v) => st.update({ direction: v }),
          {
            ariaLabel: S.changeDirection,
          },
        ),
      ),
    });
  if (f.card === "weight")
    rows.push({
      kind: "pair",
      cells: [
        segCell(
          seg(
            S.direction,
            kind === "weight_above" ? "above" : "below",
            [
              [S.above, "above"],
              [S.below, "below"],
            ],
            (v) => {
              if (!alert) st.update({ above: v === "above" });
            },
            {
              disabled: !!alert,
              title: alert ? S.directionNewOnly : undefined,
              ariaLabel: S.weightDirection,
            },
          ),
        ),
        input({
          id: "af-wth",
          label: S.thresholdPortfolio,
          value: f.threshold,
          num: true,
          inputMode: "decimal",
          onChange: (v) => st.update({ threshold: v }),
        }),
      ],
    });
  if (kind === "custom")
    rows.push({
      kind: "one",
      cell: {
        kind: "textarea",
        field: {
          id: "af-expr",
          label: S.expression,
          rows: 2,
          value: f.expression,
          placeholder: f.scope === "portfolio" ? "cash_weight < 4%" : "weight > 10%",
          onChange: (v) => st.update({ expression: v }),
        },
      },
    });
  const expiries = expiryChoices();
  const scopeItems: [string, typeof f.scope][] = [
    [S.scopeInstrument, "instrument"],
    [S.portfolio, "portfolio"],
    ...(o.buckets.length || alert?.scope === "bucket"
      ? [[S.bucket, "bucket"] as [string, typeof f.scope]]
      : []),
  ];
  return {
    heading: alert ? S.editTitle : S.newTitle,
    agent: alert?.source === "agent" ? "agent" : null,
    close: alert ? { label: S.closeEdit, title: S.closeEsc, onPress: o.onCancel } : null,
    scope: {
      ...seg(
        S.colScope,
        f.scope,
        scopeItems,
        (v) => {
          if (!alert) st.update({ scope: v });
        },
        { disabled: !!alert },
      ),
      fieldTitle: alert ? S.scopeNewOnly : undefined,
    },
    instrument:
      f.scope === "instrument"
        ? {
            id: "af-inst",
            listId: "af-inst-list",
            label: S.scopeInstrument,
            value: f.instText,
            onChange: st.pickInstrument,
            disabled: !!alert,
            placeholder: S.instPlaceholder,
            list: o.instrumentList,
            watchFirst: o.instruments.length ? null : S.watchFirst,
          }
        : null,
    bucket:
      f.scope === "bucket"
        ? {
            id: "af-bucket",
            label: S.bucket,
            value: f.bucket,
            onChange: (v) => st.update({ bucket: v }),
            // Generic buckets only (F7-generic); an agent's alert on the owner's own bucket keeps it, unnamed.
            disabled: !o.buckets.length || (!!f.bucket && !bucketName(f.bucket)),
            options: [
              ...(!o.buckets.length && !f.bucket ? [{ value: "", label: S.noBuckets }] : []),
              ...(f.bucket && !bucketName(f.bucket) ? [{ value: f.bucket, label: "-" }] : []),
              ...o.buckets.map((b) => ({ value: b, label: bucketName(b) ?? b })),
            ],
          }
        : null,
    cards: {
      label: S.condition,
      items: CARDS.map((c) => ({
        card: c.card,
        label: cardLabel(c.card),
        machine: c.machine,
        on: f.card === c.card,
        disabled:
          !st.cardOk(c) ||
          (!!alert &&
            !c.kinds.includes(alert.kind) &&
            !(c.card === "weight" && alert.kind.startsWith("weight"))),
        onPress: () => st.update({ card: c.card }),
      })),
    },
    rows,
    polarity: seg(
      S.type,
      f.polarity,
      [
        [S.chance, "positive"],
        [S.risk, "negative"],
        [S.neutral, "neutral"],
      ],
      st.setPolarity,
    ),
    severity: seg(
      S.severity,
      f.severity,
      [
        [S.info, "info"],
        [S.action, "action"],
      ],
      (v) => st.update({ severity: v }),
    ),
    title: {
      id: "af-title",
      label: S.title,
      value: st.title,
      maxLength: 120,
      onChange: st.setTitle,
    },
    note: {
      id: "af-note",
      label: S.note,
      rows: 2,
      value: f.note,
      maxLength: 2000,
      placeholder: S.notePlaceholder,
      onChange: (v) => st.update({ note: v }),
    },
    cooldown: {
      id: "af-cool",
      label: S.cooldown,
      value: f.cooldown == null ? "" : String(f.cooldown),
      onChange: (v) => st.update({ cooldown: v ? Number(v) : null }),
      options: [
        ...COOLDOWNS.map((v) => ({ value: v == null ? "" : String(v), label: cooldownLabel(v) })),
        ...(f.cooldown != null && !COOLDOWNS.includes(f.cooldown)
          ? [{ value: String(f.cooldown), label: S.days(f.cooldown) }]
          : []),
      ],
    },
    expiry: {
      id: "af-exp",
      label: S.expires,
      value: f.expiry,
      onChange: (v) => st.update({ expiry: v }),
      options: [
        { value: "", label: S.never },
        ...expiries.map((d) => ({ value: d, label: dmy(d) })),
        ...(f.expiry && !expiries.includes(f.expiry)
          ? [{ value: f.expiry, label: dmy(f.expiry) }]
          : []),
      ],
    },
    preview: st.preview,
    error: st.err,
    save: {
      label: st.busy ? S.saving : alert ? C.save : S.create,
      onPress: st.save,
      disabled: st.busy,
    },
    cancel: alert ? { label: C.cancel, onPress: o.onCancel } : null,
    noForecasts: S.noForecasts,
    onEscape: alert ? o.onCancel : null,
  };
}
