// The props of the ported signals dialog (ab24ab6 v2/Signals.tsx SignalsDialog, SignalItem, GroupActs,
// SubjectTitle, DecisionForm; v2/Decide.tsx PositionDecisionDialog): every text and row of the View, built from
// the old data (legacy numbers) and the dialog's state. The callbacks come from the screen hook. Pure.
import { S as D } from "@cashu/i18n/investments/v2/Decide.strings";
import { S as RI } from "@cashu/i18n/investments/v2/research/index.strings";
import { S } from "@cashu/i18n/investments/v2/Signals.strings";
import type { InstCardProps } from "@cashu/ui";
import { isIncognito } from "@cashu/ui-logic/core/incognito";
import { accountLabel, dm, numInput, parseNum, qty } from "@cashu/ui-logic/investments/labels";
import { decisionEffect, decisionTag } from "@cashu/ui-logic/investments/logic";
import type { Thesis } from "@cashu/ui-logic/investments/types";
import {
  instMono,
  instName,
  polarityOf,
  type SignalFilter,
  type SignalGroup,
  type SigState,
  STATE_LABEL,
  signalFact,
} from "@cashu/ui-logic/investments/v2/logic";
import { isResearchKind } from "@cashu/ui-logic/investments/v2/research/logic";
import type { SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { canUndo } from "./legacy/undo.js";
import {
  ACTION,
  type Act,
  type Age,
  defaultAct,
  type FactParts,
  factParts,
  instOf,
  lastDecision,
  longText,
  plainTitle,
  type SignalsCtx,
  signalAge,
  thesisLine,
} from "./signalsModel.js";

export type { SignalFilter };

export interface Press {
  label: string;
  onPress(): void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
}

/** A row's title line: the ticker (opens the asset), the muted full name, an extra (`n sygnałów`), the date. */
export type TitleProps =
  | {
      kind: "inst";
      ticker: string;
      sym: string | null;
      name: string | null;
      extra: string | null;
      age: Age;
      onOpen(): void;
      /** The identity label's hover card and its one-line touch title (old InstLabel inline). */
      card: { card: InstCardProps; touchTitle: string } | null;
    }
  | { kind: "plain"; title: string; sym: string | null; extra: string | null; age: Age };

export type MetricProps =
  | { kind: "decided"; tag: string; bold: string | null; tail: string; undo: Press | null }
  | { kind: "snoozed"; tag: string; fact: FactParts | null }
  | { kind: "fact"; fact: FactParts };

export interface ThesisProps {
  head: string;
  text: string;
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange(v: string): void;
}

export interface DecisionFormProps {
  seg: { label: string; items: [string, Act][]; value: Act; onChange(v: Act): void };
  /** The research effect line and its `otwórz notatki` link. */
  research: { text: string; link: Press | null } | null;
  trade: {
    quantity: FieldProps;
    price: FieldProps;
    account: {
      id: string;
      label: string;
      value: string;
      options: { value: string; label: string }[];
      onChange(v: string): void;
    };
  } | null;
  effect: string | null;
  warn: string | null;
  reason: { value: string; onChange(v: string): void; placeholder: string; label: string };
  save: Press;
  ack: Press | null;
  collapse: Press;
  noOrders: string | null;
}

export interface ItemProps {
  id: number;
  sub: boolean;
  quiet: boolean;
  cursor: boolean;
  flash: boolean;
  polarity: string;
  /** Not on a sub-row. */
  title: TitleProps | null;
  metric: MetricProps;
  long: string;
  /** A sub-row's date after the fact. */
  age: Age | null;
  thesis: ThesisProps | null;
  /** The row's action buttons (absent while the form is open or the row is settled). */
  actions: Press[] | null;
  /** The note link (research signals). */
  note: Press | null;
  form: DecisionFormProps | null;
}

export type GroupProps =
  | { kind: "single"; key: string; item: ItemProps }
  | {
      kind: "group";
      key: string;
      quiet: boolean;
      state: SigState;
      stateLabel: string;
      title: TitleProps;
      thesis: ThesisProps | null;
      items: ItemProps[];
      /** The group's one action row, or its inline form. */
      acts: { actions: Press[] | null; form: DecisionFormProps | null } | null;
    };

/** The values of the one open decision form (inline or in the position dialog). */
export interface FormValues {
  key: string;
  act: Act;
  q: string;
  price: string;
  acc: number | null;
  reason: string;
  busy: boolean;
}

/** The untouched form of `s` (or of a position without a signal): old DecisionForm's initial state. */
export function initialForm(
  key: string,
  s: SignalV2 | null,
  instrumentId: number | null,
  ctx: SignalsCtx,
): FormValues {
  const instId = s?.instrument_id ?? instrumentId;
  const pos =
    instId != null
      ? (ctx.positions.find((p) => String(p.instrument.id) === String(instId)) ?? null)
      : null;
  let q = "";
  // In incognito a pre-filled quantity (from the real holding) next to the public price would decode the
  // banana scale of the position's value: the owner types it.
  if (pos?.price && s && !isIncognito()) {
    if (s.kind === "position_concentration") {
      const over = (Number(s.payload.weight) - Number(s.payload.max_weight)) * ctx.total;
      q = over > 0 ? String(Math.max(1, Math.ceil(over / pos.price))) : "";
    } else q = defaultAct(s) === "buy" ? String(Math.max(1, Math.round(pos.quantity / 3))) : "";
  }
  const held = pos ? pos.accounts.map((a) => a.account_id) : [];
  return {
    key,
    act: defaultAct(s),
    q,
    price: numInput(pos?.price ?? null),
    acc: held[0] ?? ctx.accounts[0]?.id ?? null,
    reason: "",
    busy: false,
  };
}

/** What a save sends (old DecisionForm `save`): the input and the tag label of the toast. */
export function formInput(
  f: FormValues,
  s: SignalV2 | null,
  instrumentId: number | null,
  ctx: SignalsCtx,
) {
  const instId = s?.instrument_id ?? instrumentId;
  const pos =
    instId != null
      ? (ctx.positions.find((p) => String(p.instrument.id) === String(instId)) ?? null)
      : null;
  const trade = f.act === "buy" || f.act === "sell";
  const qn = parseNum(f.q),
    pn = parseNum(f.price);
  const currency = pos?.price_currency ?? ctx.base;
  const input = {
    action: ACTION[f.act],
    reason: f.reason.trim() || null,
    ...(trade && pos ? { quantity: qn, price: pn, currency, account_id: f.acc } : {}),
  };
  const label =
    decisionTag({ action: ACTION[f.act], quantity: trade ? qn : null }) ?? S.whatDecision;
  return { input, label };
}

/** Old DecisionForm's render: the segments, the research line, the trade fields, effect, warning, buttons. */
export function decisionFormProps(o: {
  f: FormValues;
  s: SignalV2 | null;
  instrumentId: number | null;
  ctx: SignalsCtx;
  pending: boolean;
  hideAck?: boolean;
  onChange(patch: Partial<FormValues>): void;
  onSave(): void;
  onAck?: (reason?: string) => void;
  onCollapse(): void;
  /** The research line's link: the instrument's notes (the asset). */
  onOpenNotes?: (instrumentId: number) => void;
}): DecisionFormProps {
  const { f, s, ctx } = o;
  const instId = s?.instrument_id ?? o.instrumentId;
  const pos =
    instId != null
      ? (ctx.positions.find((p) => String(p.instrument.id) === String(instId)) ?? null)
      : null;
  const trade = f.act === "buy" || f.act === "sell";
  const qn = parseNum(f.q),
    pn = parseNum(f.price);
  const currency = pos?.price_currency ?? ctx.base;
  const bucketId =
    pos?.bucket ?? (s?.kind === "allocation_drift" ? String(s.payload.bucket_id) : null);
  const fid = s?.id ?? `p${instId}`;
  const bucket = ctx.buckets.find((b) => b.bucket_id === bucketId) ?? null;
  const effect =
    trade && pos
      ? decisionEffect({
          side: f.act === "buy" ? "buy" : "sell",
          quantity: qn,
          price: pn,
          currency,
          bucket,
          total: ctx.total,
          base: ctx.base,
        })
      : null;
  const invalid = trade && pos != null && (qn == null || qn <= 0 || pn == null || pn <= 0);
  const held = pos ? pos.accounts.map((a) => a.account_id) : [];
  const accounts = held.length ? ctx.accounts.filter((a) => held.includes(a.id)) : ctx.accounts;
  return {
    seg: {
      label: S.decision,
      items: [
        [S.actNone, "none"],
        [S.actBuy, "buy"],
        [S.actSell, "sell"],
        [S.actLater, "later"],
      ],
      value: f.act,
      onChange: (act) => o.onChange({ act }),
    },
    research: researchLine(instId, ctx, o.onOpenNotes),
    trade:
      trade && pos
        ? {
            quantity: {
              id: `dq-${fid}`,
              label: S.quantity,
              value: f.q,
              onChange: (q) => o.onChange({ q }),
            },
            price: {
              id: `dp-${fid}`,
              label: S.price,
              value: f.price,
              onChange: (price) => o.onChange({ price }),
            },
            account: {
              id: `da-${fid}`,
              label: S.accountLabel,
              value: f.acc == null ? "" : String(f.acc),
              options: accounts.map((a) => ({
                value: String(a.id),
                label: accountLabel(a, ctx.accounts),
              })),
              onChange: (v) => o.onChange({ acc: Number(v) }),
            },
          }
        : null,
    effect,
    warn:
      trade && pos && pos.quantity > 0 && f.act === "sell" && qn != null && qn > pos.quantity
        ? S.youHave(qty(pos.quantity))
        : null,
    reason: {
      value: f.reason,
      onChange: (reason) => o.onChange({ reason }),
      placeholder: S.why,
      label: S.reasonAria,
    },
    save: {
      label: S.saveDecision,
      onPress: o.onSave,
      disabled: invalid || f.busy || o.pending,
      primary: true,
    },
    ack:
      !o.hideAck && o.onAck
        ? {
            label: S.ack,
            onPress: () => o.onAck?.(f.reason.trim() || undefined),
            disabled: f.busy || o.pending,
          }
        : null,
    collapse: { label: S.collapse, onPress: o.onCollapse },
    noOrders: trade && pos ? S.noOrders : null,
  };
}

function researchLine(
  instId: number | null,
  ctx: SignalsCtx,
  open: ((id: number) => void) | undefined,
): DecisionFormProps["research"] {
  const text = instId != null ? ctx.researchEffect(instId) : null;
  if (instId == null || !text) return null;
  return { text, link: open ? { label: RI.openNotes, onPress: () => open(instId) } : null };
}

/** Old SubjectTitle. */
export function titleProps(
  s: SignalV2,
  ctx: SignalsCtx,
  extra: string | null,
  onOpen: (id: number) => void,
): TitleProps {
  const age = signalAge(s, ctx);
  const io = instOf(ctx, s.instrument_id);
  if (io) {
    const name = instName(io.inst);
    const ticker = io.inst.symbol ? instMono({ symbol: io.inst.symbol, name, label: name }) : name;
    // The inline identity label: the ticker, then its symbol when that differs (old `.il.inl .sym`).
    const sym = io.inst.symbol && io.inst.symbol !== ticker ? io.inst.symbol : null;
    return {
      kind: "inst",
      ticker,
      sym,
      name: ticker !== name ? name : null,
      extra,
      age,
      onOpen: () => onOpen(Number(io.inst.id)),
      card: ctx.instCard?.(io) ?? null,
    };
  }
  const t = plainTitle(s, ctx);
  return { kind: "plain", title: t.title, sym: t.sym, extra, age };
}

export const thesisProps = (t: Thesis | null): ThesisProps | null =>
  t && (t.thesis || t.exit_plan) ? thesisLine(t) : null;

/** Old SignalItem's metric line. */
function metricProps(s: SignalV2, undo: (() => void) | null): MetricProps {
  const decided = lastDecision(s);
  const fact = signalFact(s);
  if (decided)
    return {
      kind: "decided",
      tag: decisionTag(decided) ?? "",
      bold: fact.bold || null,
      tail:
        s.kind === "position_concentration" || s.kind === "allocation_drift" ? S.backInSummary : "",
      undo: decided && canUndo(decided) && undo ? { label: S.undo, onPress: undo } : null,
    };
  if (s.snoozed)
    return {
      kind: "snoozed",
      tag: `${S.snoozedTag}${s.snoozed_until ? ` ${S.toDate(dm(s.snoozed_until))}` : ""}`,
      fact: fact.bold ? factParts(fact) : null,
    };
  return { kind: "fact", fact: factParts(fact) };
}

interface ItemCallbacks {
  onDecide(): void;
  onAck(): void;
  onSnooze(): void;
  onNote: (() => void) | null;
  onUndo: (() => void) | null;
  onOpenAsset(id: number): void;
}

/** Old SignalItem. `grouped`: a sub-row whose decision / acknowledgement live in the group's action row. */
export function itemProps(o: {
  s: SignalV2;
  ctx: SignalsCtx;
  thesis: Thesis | null;
  sub: boolean;
  open: boolean;
  cursor: boolean;
  primary: boolean;
  flash: boolean;
  busy: boolean;
  later: string;
  form: DecisionFormProps | null;
  cb: ItemCallbacks;
}): ItemProps {
  const { s, ctx, sub } = o;
  const decided = lastDecision(s);
  const quiet = !!decided || !!s.snoozed;
  const research = isResearchKind(s.kind) || s.source === "research";
  const snooze: Press | null =
    s.kind === "contribution_gap"
      ? { label: S.snoozeTo(dm(o.later)), onPress: o.cb.onSnooze, disabled: o.busy }
      : null;
  const note: Press | null =
    research && o.cb.onNote ? { label: S.noteLink, onPress: o.cb.onNote } : null;
  let actions: Press[] | null = null;
  let form: DecisionFormProps | null = null;
  if (!quiet) {
    if (sub) actions = snooze ? [snooze] : note ? [] : null;
    else if (o.open) form = o.form;
    else
      actions = [
        { label: S.recordDecision, onPress: o.cb.onDecide, primary: o.primary },
        { label: S.ack, onPress: o.cb.onAck, disabled: o.busy },
        ...(snooze ? [snooze] : []),
      ];
  }
  return {
    id: s.id,
    sub,
    quiet,
    cursor: o.cursor && !o.open,
    flash: o.flash,
    polarity: polarityOf(s),
    title: sub ? null : titleProps(s, ctx, null, o.cb.onOpenAsset),
    metric: metricProps(s, o.cb.onUndo),
    long: longText(s, ctx),
    age: sub ? signalAge(s, ctx) : null,
    thesis: !sub && !quiet ? thesisProps(o.thesis) : null,
    actions,
    note: !quiet && !(!sub && o.open) ? note : null,
    form,
  };
}

/** Old GroupActs' action row (nothing once every signal is settled). */
export function groupActions(
  g: SignalGroup<SignalV2>,
  primary: boolean,
  busy: boolean,
  onDecide: () => void,
  onAck: () => void,
): Press[] | null {
  if (!g.live.length || !g.primary) return null;
  const n = g.live.length;
  return [
    {
      label: S.recordDecision,
      onPress: onDecide,
      primary,
      title: n > 1 ? S.oneDecisionFor(n) : undefined,
    },
    { label: S.ack, onPress: onAck, disabled: busy, title: n > 1 ? S.acksN(n) : undefined },
  ];
}

export const groupHead = (g: SignalGroup<SignalV2>) => ({
  state: g.state,
  stateLabel: STATE_LABEL[g.state],
  count: S.signalsCount(g.signals.length),
});

// ---- the position decision dialog (Decide.tsx) -------------------------------------------------------------

const MAX_LINES = 5;

export interface PositionDialogProps {
  label: string;
  title: string;
  ticker: string;
  name: string | null;
  kick: string;
  lines: { id: number; polarity: string; fact: FactParts; age: Age; long: string }[];
  more: string | null;
  thesis: { head: string; text: string } | null;
  form: DecisionFormProps;
  onClose(): void;
}

export function positionDialogProps(o: {
  name: string;
  symbol: string | null;
  signals: SignalV2[];
  ctx: SignalsCtx;
  thesis: Thesis | null;
  form: DecisionFormProps;
  onClose(): void;
}): PositionDialogProps {
  const lines = o.signals.slice(0, MAX_LINES);
  const more = o.signals.length - lines.length;
  const th = o.thesis?.exit_plan
    ? { head: D.exitPlan, text: o.thesis.exit_plan }
    : o.thesis?.thesis
      ? { head: D.thesis, text: o.thesis.thesis }
      : null;
  const split = o.symbol && o.symbol !== o.name;
  return {
    label: D.dialogLabel(o.name),
    title: D.decision,
    ticker: split ? (o.symbol ?? o.name) : o.name,
    name: split ? o.name : null,
    kick: o.signals.length ? D.openSignals : D.noOpenSignals,
    lines: lines.map((s) => ({
      id: s.id,
      polarity: polarityOf(s),
      fact: factParts(signalFact(s)),
      age: signalAge(s, o.ctx),
      long: longText(s, o.ctx),
    })),
    more: more > 0 ? `+${more}` : null,
    thesis: th,
    form: o.form,
    onClose: o.onClose,
  };
}
