// The state of the ported alert form (ab24ab6 v2/Alerts.tsx AlertForm) in its edit mode: the standardized schema
// of one existing alert. The kind, scope and instrument never change by PATCH, so they are fixed here; the kind
// defaults of the old `useEffect([kind])` fill the stored params once. The save goes through the old patch shape
// (useLegacySignalsApi). Alerts are created by the agent (MCP) and the strategy, never in this form.
import { inEveryLang } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/Alerts.strings";
import { describeError } from "@cashu/ui-logic/core/messages";
import { bucketLabel, parseNum } from "@cashu/ui-logic/investments/labels";
import { alertDefaultTitle, alertPreview } from "@cashu/ui-logic/investments/v2/logic";
import type { Alert } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import { choiceText, type InstrumentChoice, type KindCard, type Scope } from "./alertsModel.js";
import {
  type AlertDraftText,
  alertPatch,
  buildParams,
  draftText,
  expiryChoice,
  validate,
} from "./legacy/alertForm.js";
import type { LegacySignalsApi } from "./useLegacySignalsApi.js";

export interface AlertFormInput {
  api: LegacySignalsApi;
  alert: Alert;
  instruments: InstrumentChoice[];
  buckets: string[];
  digestWeekday: string;
  onCancel(): void;
  onSaved(): void;
}

interface FormState extends AlertDraftText {
  polarity: string;
  severity: string;
  title: string;
  titleTouched: boolean;
  note: string;
  cooldown: number | null;
  expiry: string;
}

/** The kind defaults (old `useEffect([kind])`): window and direction per kind, for params the alert lacks. */
function kindDefaults(f: FormState, alert: Alert): FormState {
  const kind = alert.kind;
  const n = { ...f };
  if (!n.windowDays && (kind === "drawdown_from_high" || kind === "new_high")) n.windowDays = "252";
  if (!n.windowDays && kind === "sma_cross") n.windowDays = "200";
  if (!n.windowDays && kind === "change_pct") n.windowDays = "30";
  if (kind === "sma_cross" && n.direction !== "above" && n.direction !== "below")
    n.direction = "below";
  if (kind === "change_pct" && !["up", "down", "any"].includes(n.direction)) n.direction = "down";
  if (kind === "range_breakout") {
    if (!n.windowDays) n.windowDays = "30";
    if (!n.rangePct) n.rangePct = "8";
    const stored = String(alert.params.direction ?? "any");
    n.direction = ["up", "down", "any"].includes(stored) ? stored : "any";
  }
  if (kind === "volume_spike") {
    if (!n.windowDays) n.windowDays = "20";
    if (!n.multiple) n.multiple = S.defaultMultiple;
  }
  return n;
}

export function useAlertForm(o: AlertFormInput) {
  const { alert, instruments, buckets } = o;
  const kind = alert.kind;
  const scope = alert.scope as Scope;
  const card: KindCard = kind.startsWith("weight") ? "weight" : (kind as KindCard);
  const inst = instruments.find((i) => i.id === alert.instrument_id) ?? null;
  const [t0] = useState(() => draftText(alert.params, buckets[0] ?? ""));
  const [f, setF] = useState<FormState>(() => {
    // A title that is still the generated one keeps following the condition (either language).
    const generated = inEveryLang(() =>
      alertDefaultTitle(
        alert.kind,
        alert.params,
        alert.instrument?.symbol ??
          alert.instrument?.label ??
          (alert.scope === "bucket"
            ? (bucketLabel(String(alert.params.bucket ?? "")) ?? S.bucket)
            : S.portfolio),
        alert.instrument?.currency,
      ),
    ).includes(alert.title);
    return kindDefaults(
      {
        ...t0,
        rangePct: t0.rangePct ?? "",
        multiple: t0.multiple ?? "",
        polarity: alert.polarity,
        severity: alert.severity,
        title: alert.title,
        titleTouched: !generated,
        note: alert.note ?? "",
        // "bez pauzy" (null) stays null.
        cooldown: alert.cooldown_days,
        expiry: expiryChoice(alert.expires_at),
      },
      alert,
    );
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));

  const params = buildParams(kind, scope, f);
  const subject =
    scope === "instrument"
      ? (inst?.symbol ?? inst?.label ?? "")
      : scope === "bucket"
        ? (bucketLabel(f.bucket) ?? S.bucket)
        : S.portfolio;
  const problems = validate(kind, scope, params, inst, f.bucket);
  // The title follows the condition until the owner edits it; nothing to suggest while the condition is incomplete.
  const autoTitle = problems.length ? "" : alertDefaultTitle(kind, params, subject, inst?.currency);
  const title = f.titleTouched ? f.title : autoTitle;
  const preview = problems.length
    ? null
    : alertPreview({
        kind,
        params,
        subject: inst?.symbol ?? inst?.label ?? subject,
        currency: inst?.currency,
        now: kind.startsWith("price") ? (inst?.price ?? null) : null,
        polarity: f.polarity,
        severity: f.severity,
        cooldown: f.cooldown,
        digestWeekday: o.digestWeekday,
      });

  const save = async () => {
    const first = problems[0];
    if (first) {
      setErr(first);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Only what the owner changed; untouched values go back exactly as stored (F7 FE4).
      const patch = alertPatch(alert, {
        title: title.trim() || alertDefaultTitle(kind, params, subject, inst?.currency),
        params,
        initialParams: buildParams(alert.kind, alert.scope, t0),
        polarity: f.polarity,
        severity: f.severity,
        note: f.note.trim() || null,
        cooldown_days: f.cooldown,
        expiry: f.expiry,
      });
      if (Object.keys(patch).length) await o.api.patchAlert(alert.id, patch);
      o.onSaved();
    } catch (e) {
      const d = describeError(e);
      setErr(d.detail ? `${d.text} (${d.detail})` : d.text);
    } finally {
      setBusy(false);
    }
  };
  const lv = parseNum(f.level);
  const distNow =
    inst?.price != null && lv != null && inst.price > 0 ? (lv - inst.price) / inst.price : null;
  return {
    alert,
    f,
    kind,
    scope,
    card,
    inst,
    instText: inst ? choiceText(inst) : (alert.instrument?.label ?? ""),
    title,
    preview,
    busy,
    err,
    distNow,
    update,
    setTitle: (v: string) => update({ title: v, titleTouched: true }),
    save: () => void save(),
  };
}
export type AlertFormState = ReturnType<typeof useAlertForm>;
