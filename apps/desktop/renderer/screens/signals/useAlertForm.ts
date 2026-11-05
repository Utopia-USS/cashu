// The state of the ported alert form (ab24ab6 v2/Alerts.tsx AlertForm): the standardized schema of one alert,
// new or edited. The old effects (kind defaults, a card the scope does not allow, the breakout polarity, the
// generated title) run inside the updates here, so one change lands as one state. The save goes through the
// old create / patch shape (useLegacySignalsApi).
import { inEveryLang } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/Alerts.strings";
import { describeError } from "@cashu/ui-logic/core/messages";
import { bucketLabel, parseNum } from "@cashu/ui-logic/investments/labels";
import { alertDefaultTitle, alertPreview } from "@cashu/ui-logic/investments/v2/logic";
import type { Alert } from "@cashu/ui-logic/investments/v2/types";
import { useState } from "react";
import {
  breakoutPolarity,
  CARDS,
  choiceText,
  DEFAULT_POLARITY,
  type InstrumentChoice,
  type KindCard,
  type Scope,
} from "./alertsModel.js";
import {
  type AlertDraftText,
  alertPatch,
  buildParams,
  draftText,
  expiryChoice,
  expiryValue,
  formKind,
  validate,
} from "./legacy/alertForm.js";
import type { LegacySignalsApi } from "./useLegacySignalsApi.js";

export interface AlertFormInput {
  api: LegacySignalsApi;
  alert: Alert | null;
  instruments: InstrumentChoice[];
  buckets: string[];
  digestWeekday: string;
  /** Kind -> allowed scopes (the host's catalog). */
  catalog: Record<string, readonly string[]>;
  presetInstrument: number | null;
  onCancel(): void;
  onSaved(title: string, created: boolean): void;
}

interface FormState extends AlertDraftText {
  scope: Scope;
  instId: number | null;
  instText: string;
  card: KindCard;
  above: boolean;
  polarity: string;
  polarityTouched: boolean;
  severity: string;
  title: string;
  titleTouched: boolean;
  note: string;
  cooldown: number | null;
  expiry: string;
}

const kindOf = (f: Pick<FormState, "card" | "above">, alert: Alert | null) =>
  formKind(f.card, f.above, alert?.kind ?? null);

/** The kind defaults (old `useEffect([kind])`): window and direction per kind, polarity until touched. */
function kindDefaults(f: FormState, kind: string, alert: Alert | null): FormState {
  const n = { ...f };
  if (!n.polarityTouched) n.polarity = DEFAULT_POLARITY[kind] ?? "neutral";
  if (!n.windowDays && (kind === "drawdown_from_high" || kind === "new_high")) n.windowDays = "252";
  if (!n.windowDays && kind === "sma_cross") n.windowDays = "200";
  if (!n.windowDays && kind === "change_pct") n.windowDays = "30";
  if (kind === "sma_cross" && n.direction !== "above" && n.direction !== "below")
    n.direction = "below";
  if (kind === "change_pct" && !["up", "down", "any"].includes(n.direction)) n.direction = "down";
  if (kind === "range_breakout") {
    if (!n.windowDays) n.windowDays = "30";
    if (!n.rangePct) n.rangePct = "8";
    // A direction picked on another card does not carry over: `oba` unless the stored alert has one (FE-8).
    const stored =
      alert?.kind === "range_breakout" ? String(alert.params.direction ?? "any") : "any";
    n.direction = ["up", "down", "any"].includes(stored) ? stored : "any";
  }
  if (kind === "volume_spike") {
    if (!n.windowDays) n.windowDays = "20";
    if (!n.multiple) n.multiple = S.defaultMultiple;
  }
  return n;
}

/** The breakout's polarity follows its direction until touched (old `useEffect([kind, direction])`). */
const breakout = (f: FormState, kind: string): FormState =>
  kind === "range_breakout" && !f.polarityTouched
    ? { ...f, polarity: breakoutPolarity(f.direction) }
    : f;

export function useAlertForm(o: AlertFormInput) {
  const { alert, instruments, buckets, catalog } = o;
  const [t0] = useState(() => draftText(alert?.params, buckets[0] ?? ""));
  const cardOk = (c: (typeof CARDS)[number], scope: Scope) =>
    c.kinds.some((k) => (catalog[k] ?? []).includes(scope));
  const [f, setF] = useState<FormState>(() => {
    const presetId = alert?.instrument_id ?? o.presetInstrument ?? null;
    const inst = instruments.find((i) => i.id === presetId) ?? null;
    const generated =
      !!alert &&
      inEveryLang(() =>
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
    const start: FormState = {
      ...t0,
      rangePct: t0.rangePct ?? "",
      multiple: t0.multiple ?? "",
      scope:
        (alert?.scope as Scope) ??
        (o.presetInstrument != null || instruments.length ? "instrument" : "portfolio"),
      instId: presetId,
      instText: inst ? choiceText(inst) : (alert?.instrument?.label ?? ""),
      card: alert
        ? alert.kind.startsWith("weight")
          ? "weight"
          : (alert.kind as KindCard)
        : "price_below",
      above: alert?.kind === "weight_above",
      polarity: alert?.polarity ?? "neutral",
      polarityTouched: !!alert,
      severity: alert?.severity ?? "info",
      title: alert?.title ?? "",
      // An edited alert whose title is still the generated one keeps following the condition (either language).
      titleTouched: !!alert && !generated,
      note: alert?.note ?? "",
      // "bez pauzy" (null) stays null when editing; 14 days only for a new alert.
      cooldown: alert ? alert.cooldown_days : 14,
      expiry: expiryChoice(alert?.expires_at),
    };
    const kind = kindOf(start, alert);
    const cur = CARDS.find((c) => c.card === start.card);
    const card =
      cur && !cardOk(cur, start.scope)
        ? ((CARDS.find((c) => cardOk(c, start.scope))?.card ?? "custom") as KindCard)
        : start.card;
    const withCard = { ...start, card };
    return breakout(
      kindDefaults(withCard, kindOf(withCard, alert) ?? kind, alert),
      kindOf(withCard, alert),
    );
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** One change: a new kind applies its defaults; a new scope drops a card it does not allow. */
  const update = (patch: Partial<FormState>) =>
    setF((prev) => {
      let next = { ...prev, ...patch };
      if (patch.scope !== undefined && patch.scope !== prev.scope) {
        const cur = CARDS.find((c) => c.card === next.card);
        if (cur && !cardOk(cur, next.scope))
          next.card = (CARDS.find((c) => cardOk(c, next.scope))?.card ?? "custom") as KindCard;
      }
      const kind = kindOf(next, alert);
      if (kind !== kindOf(prev, alert)) next = kindDefaults(next, kind, alert);
      return breakout(next, kind);
    });

  const kind = kindOf(f, alert);
  const inst = instruments.find((i) => i.id === f.instId) ?? null;
  const params = buildParams(kind, f.scope, f);
  const subject =
    f.scope === "instrument"
      ? (inst?.symbol ?? inst?.label ?? "")
      : f.scope === "bucket"
        ? (bucketLabel(f.bucket) ?? S.bucket)
        : S.portfolio;
  const problems = validate(kind, f.scope, params, inst, f.bucket);
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
    const body = {
      kind,
      title: title.trim() || alertDefaultTitle(kind, params, subject, inst?.currency),
      params,
      scope: f.scope,
      instrument_id: f.scope === "instrument" ? f.instId : null,
      polarity: f.polarity,
      severity: f.severity,
      note: f.note.trim() || null,
      cooldown_days: f.cooldown,
      expires_at: f.expiry ? expiryValue(f.expiry) : null,
    };
    try {
      if (alert) {
        // Only what the owner changed; untouched values go back exactly as stored (F7 FE4).
        const patch = alertPatch(alert, {
          title: body.title,
          params,
          initialParams: buildParams(alert.kind, alert.scope, t0),
          polarity: f.polarity,
          severity: f.severity,
          note: body.note ?? null,
          cooldown_days: f.cooldown,
          expiry: f.expiry,
        });
        if (Object.keys(patch).length) await o.api.patchAlert(alert.id, patch);
        o.onSaved(body.title, false);
      } else {
        const r = await o.api.postAlert(body);
        o.onSaved(r.title, true);
      }
    } catch (e) {
      const d = describeError(e);
      setErr(d.detail ? `${d.text} (${d.detail})` : d.text);
    } finally {
      setBusy(false);
    }
  };
  const pickInstrument = (text: string) => {
    const hit = instruments.find(
      (i) => choiceText(i) === text || i.symbol?.toLowerCase() === text.trim().toLowerCase(),
    );
    update({ instText: text, instId: hit?.id ?? null });
  };
  const lv = parseNum(f.level);
  const distNow =
    inst?.price != null && lv != null && inst.price > 0 ? (lv - inst.price) / inst.price : null;
  return {
    alert,
    f,
    kind,
    inst,
    title,
    preview,
    busy,
    err,
    distNow,
    cardOk: (c: (typeof CARDS)[number]) => cardOk(c, f.scope),
    update,
    pickInstrument,
    setTitle: (v: string) => update({ title: v, titleTouched: true }),
    setPolarity: (v: string) => update({ polarity: v, polarityTouched: true }),
    save: () => void save(),
  };
}
export type AlertFormState = ReturnType<typeof useAlertForm>;
