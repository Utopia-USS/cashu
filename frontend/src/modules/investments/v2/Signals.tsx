// Sygnały (ia-v2.md 6, F-01/F-05; signals-rail.md 2-3): rule signals and triggered alerts in one list by
// polarity (Szanse | Ryzyka i przegląd), plain words instead of rule ids. On the home a rail widget shows the
// four newest undecided signals per polarity as compact rows (actions on hover / focus / the j / k cursor);
// `Wszystkie (n)` opens the dialog with the full two-column list: the thesis under the signal that fired,
// actions in place (Zanotuj decyzję, Potwierdź, Odłóż do …), decided items quiet at the bottom. A decision
// is saved at once; `Cofnij` in the toast deletes it within the server's 15-minute window (F5 R4).
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { ApiError } from "../../../core/api";
import { errorText } from "../../../core/messages";
import { useAsync, useInFlight } from "../../../hooks";
import { Seg, Skeleton, useModal, useToast } from "../../../ui";
import { AgentTag, PolDot, Widget } from "../../../widgets";
import {
  type AccountRow, type BucketRow, deleteDecision, type DecisionInput, getPositionDetail, postAcknowledge, postDecision, postSnooze, type Thesis,
} from "../api";
import { useShortcuts } from "../hooks";
import { accountLabel, dm, ENTRY_TYPE, numInput, parseNum, plural, qty } from "../labels";
import { decisionEffect, decisionTag, nextDeposit } from "../logic";
import { canUndo, makeUndo, type Undo, undoMessage, undoSettled } from "../undo";
import { type Alert, invKey, type PositionV2, type SignalV2 } from "./api";
import { InstLabel } from "./InstLabel";
import { instName, isDecided, polarityOf, railTop, signalStateKey, signalText, splitByPolarity } from "./logic";
import { stillLocked } from "../../../inflight";
import { isResearchKind, signalNoteId } from "./research/logic";
import { localDay, parseServerTime } from "../../../time";

type Act = "none" | "buy" | "sell" | "later";
const ACTION: Record<Act, string> = { none: "held", buy: "bought", sell: "sold", later: "other" };

export interface SignalsCtx {
  slug: string;
  positions: PositionV2[];
  buckets: BucketRow[];
  total: number;
  base: string;
  accounts: AccountRow[];
  today: string;
  contributionDay: number | null;
  alertsById: Map<number, Alert>;
  onChanged: () => void;
  onOpenAsset: (instrumentId: number) => void;
  /** Research layer (F6): the strip exists (footer copy), `notatka` opens the note (drawer or research view),
   * the decision form's `research z soboty: …` line for an instrument. */
  researchOn?: boolean;
  onOpenNote?: (instrumentId: number | null, noteId: number | null, theme: string | null) => void;
  researchEffect?: (instrumentId: number) => ReactNode;
}

/** Polarity filter of the dialog (`Wszystkie | Szanse n | Ryzyka n`). */
export type SignalFilter = "all" | "positive" | "negative";

const ageText = (iso: string | null, today: string) => (!iso ? "" : localDay(iso) === today ? "dziś" : `od ${dm(iso)}`);
/** Signals with a decision saved in the last 7 days (footer `decyzje: n z m w tym tygodniu`). */
const decidedThisWeek = (list: SignalV2[]) => {
  const weekAgo = Date.now() - 7 * 86400000;
  return list.filter((s) => s.decisions.some((d) => parseServerTime(d.created_at) >= weekAgo)).length;
};

/** j / k move a cursor over `order` (the row scrolls into view inside `root`), Enter opens or closes its
 * decision form; off while `enabled` is false. */
function useCursor(order: SignalV2[], root: RefObject<HTMLElement>, enabled: boolean) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const move = (d: number) => {
    if (!order.length) return;
    const i = order.findIndex((s) => s.id === cursor);
    const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + d))];
    setCursor(next.id);
    root.current?.querySelector(`[data-signal="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({
    j: () => move(1),
    k: () => move(-1),
    Enter: () => { if (cursor != null) setOpenId((cur) => (cur === cursor ? null : cursor)); },
  }, enabled);
  return { openId, setOpenId, cursor, setCursor };
}

/** Scroll to a signal inside `root`, flash it once and put the cursor on it (a notification link). */
function useFocusSignal(focusId: number | null | undefined, present: boolean, root: RefObject<HTMLElement>, setCursor: (id: number) => void) {
  useEffect(() => {
    if (!present || focusId == null) return;
    setCursor(focusId);
    const t = setTimeout(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-signal="${focusId}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 2600);
    }, 60);
    return () => clearTimeout(t);
  }, [focusId, present]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The home's Sygnały rail widget (signals-rail.md 2): per polarity its count and the four newest undecided
 * signals as compact rows; footer = this week's decisions + `Wszystkie (n)` (the dialog). */
export function SignalsRail({ signals, ctx, focusId, onAll, hl, paused }: {
  signals: SignalV2[] | null;
  ctx: SignalsCtx;
  /** A notification link (`?signal=<id>`) to one of the rail's rows: scroll to it, flash it, cursor on it. */
  focusId?: number | null;
  /** `Wszystkie (n)`: open the dialog (on one polarity when given). */
  onAll: (filter?: SignalFilter) => void;
  /** Review step 2 (Sygnały). */
  hl?: boolean;
  /** The dialog is open: its keyboard owns j / k / Enter. */
  paused?: boolean;
}) {
  const list = signals ?? [];
  const { positive, negative } = splitByPolarity(list);
  const top = { positive: railTop(list, "positive"), negative: railTop(list, "negative") };
  const rows = [...top.positive, ...top.negative];
  const ref = useRef<HTMLDivElement>(null);
  const { openId, setOpenId, cursor, setCursor } = useCursor(rows, ref, !paused);
  useFocusSignal(focusId, focusId != null && rows.some((s) => s.id === focusId), ref, setCursor);
  const section = (polarity: "positive" | "negative", label: string, count: number, items: SignalV2[]) => (
    <div className="rgrp">
      <div className="polh"><PolDot polarity={polarity} />{label} <span className="cnt">{count}</span></div>
      {items.length ? items.map((s) => (
        <SignalItem key={s.id} compact s={s} ctx={ctx} thesis={null} open={openId === s.id} cursor={cursor === s.id} primary
          onToggle={(v) => { setOpenId(v ? s.id : null); if (v) setCursor(s.id); }} />
      )) : <div className="none">Brak</div>}
    </div>
  );
  return (
    <Widget title="Sygnały" id="inv-signals" hl={hl} count={list.length || undefined} body="tight" className="srail"
      footer={!signals ? undefined : list.length ? (
        <><span>decyzje: <b>{decidedThisWeek(list)} z {list.length}</b> w tym tygodniu</span><span className="spacer" />
          <button className="lnk" onClick={() => onAll()}>Wszystkie ({list.length})</button></>
      ) : <><span className="spacer" /><button className="lnk" disabled>Wszystkie (0)</button></>}>
      {!signals ? <Skeleton h={140} /> : !list.length ? (
        <div className="empty">Brak otwartych sygnałów.</div>
      ) : (
        <div ref={ref}>
          {section("positive", "Szanse", positive.length, top.positive)}
          {section("negative", "Ryzyka i przegląd", negative.length, top.negative)}
        </div>
      )}
    </Widget>
  );
}

/** All open signals (signals-rail.md 3): a centered modal with the two-column list, a polarity filter and the
 * footer (decisions this week, expired since the last review, the journal). Review mode: the keyboard hint,
 * the cursor on the first undecided signal, `bez decyzji: n`. Leaving to an asset, a note or the journal
 * closes it first. */
export function SignalsDialog({ signals, ctx, filter: initial = "all", focusId, review, expired, onHistory, onClose }: {
  signals: SignalV2[];
  ctx: SignalsCtx;
  filter?: SignalFilter;
  /** A notification link to a signal outside the rail's rows: scroll to it, flash it, cursor on it. */
  focusId?: number | null;
  review?: boolean;
  /** Signals that expired since the last review (digest), for the footer. */
  expired?: { title: string }[];
  onHistory: () => void;
  onClose: () => void;
}) {
  const list = signals;
  const { positive, negative } = splitByPolarity(list);
  const [filter, setFilter] = useState<SignalFilter>(initial);
  const shown = { positive: filter !== "negative" ? positive : [], negative: filter !== "positive" ? negative : [] };
  const order = [...shown.positive, ...shown.negative].filter((x) => !isDecided(x) && !x.snoozed);
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, true, onClose, { focus: "panel" });
  const { openId, setOpenId, cursor, setCursor } = useCursor(order, ref, true);
  const theses = useTheses(ctx.slug, list, ctx.positions);
  // Review step 2 puts the cursor on the first undecided signal.
  useEffect(() => { if (review && focusId == null && order[0]) setCursor(order[0].id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusSignal(focusId, focusId != null && list.some((s) => s.id === focusId), ref, setCursor);
  const leave = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { onClose(); fn(...a); };
  const dctx: SignalsCtx = { ...ctx, onOpenAsset: leave(ctx.onOpenAsset), onOpenNote: ctx.onOpenNote && leave(ctx.onOpenNote) };
  const decided = list.filter(isDecided).length;
  const col = (polarity: "positive" | "negative", items: SignalV2[], count: number) => (
    <div>
      <div className="polh"><PolDot polarity={polarity} />{polarity === "positive" ? "Szanse" : "Ryzyka i przegląd"} <span className="cnt">{count}</span></div>
      {items.length ? items.map((s) => (
        <SignalItem key={s.id} s={s} ctx={dctx} thesis={s.instrument_id != null ? theses.get(s.instrument_id) ?? null : null}
          open={openId === s.id} cursor={cursor === s.id} primary={s.id === (order[0]?.id ?? -1)}
          onToggle={(v) => { setOpenId(v ? s.id : null); if (v) setCursor(s.id); }} />
      )) : <div className="muted" style={{ fontSize: 12.5, padding: "8px 0" }}>Brak</div>}
    </div>
  );
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <div className="sdlg" role="dialog" aria-modal="true" aria-label="Sygnały" ref={ref} tabIndex={-1}>
        <div className="dh">
          <strong>Sygnały</strong>
          {list.length > 0 && <span className="tag">{list.length}</span>}
          {review && decided > 0 && <span className="tag solid pos">{plural(decided, "rozstrzygnięty", "rozstrzygnięte", "rozstrzygniętych")}</span>}
          <Seg<SignalFilter> quiet label="Filtr sygnałów" value={filter} onChange={setFilter}
            items={[["Wszystkie", "all"], [`Szanse ${positive.length}`, "positive"], [`Ryzyka ${negative.length}`, "negative"]]} />
          <span className="spacer" />
          <span className="hint">j / k: następny · Enter: decyzja</span>
          <button className="icon-btn" title="Zamknij (Esc)" aria-label="Zamknij" onClick={onClose}>✕</button>
        </div>
        <div className="db">
          {!list.length ? <div className="empty">Brak otwartych sygnałów.</div> : filter === "all" ? (
            <div className="pol2">{col("positive", positive, positive.length)}{col("negative", negative, negative.length)}</div>
          ) : col(filter, filter === "positive" ? positive : negative, filter === "positive" ? positive.length : negative.length)}
        </div>
        <div className="wf">
          {review ? <span>bez decyzji: <b>{list.length - decided}</b></span> : (
            <>
              <span>decyzje: <b>{decidedThisWeek(list)} z {list.length}</b> w tym tygodniu</span>
              {expired && expired.length > 0 && <span>{plural(expired.length, "sygnał wygasł", "sygnały wygasły", "sygnałów wygasło")} ({expired.slice(0, 2).map((e) => e.title).join(", ")})</span>}
            </>
          )}
          <span className="spacer" />
          <button className="lnk" onClick={leave(onHistory)}>dziennik</button>
        </div>
      </div>
    </>
  );
}

/** Latest thesis of every instrument with an open signal (one detail request per instrument). */
function useTheses(slug: string, list: SignalV2[], positions: PositionV2[]): Map<number, Thesis> {
  const ids = [...new Set(list.filter((s) => s.instrument_id != null && positions.some((p) => String(p.instrument.id) === String(s.instrument_id) && p.has_thesis)).map((s) => s.instrument_id!))].sort();
  const q = useAsync(async () => {
    const out = new Map<number, Thesis>();
    await Promise.all(ids.map((id) => getPositionDetail(slug, id).then((d) => {
      const t = d.theses[d.theses.length - 1];
      if (t) out.set(id, t);
    }).catch(() => undefined)));
    return out;
  }, [slug, ids.join(",")],
  // Looked up by instrument id, so the previous set's theses stay right for their instruments while a new set
  // loads (F7 PX2b opt-in: no thesis line flickers off when a signal comes or goes).
  { key: invKey(slug, "theses", ids.join(",")), keepPrevious: true });
  return q.data ?? new Map();
}

function thesisLine(t: Thesis): string {
  return [t.entry_type ? ENTRY_TYPE[t.entry_type] ?? t.entry_type : null, t.size_plan, t.exit_plan ? `wyjście ${t.exit_plan}` : null].filter(Boolean).join(" · ");
}

export function SignalItem({ s, ctx, thesis, open, cursor, primary, onToggle, compact }: {
  s: SignalV2; ctx: SignalsCtx; thesis: Thesis | null; open: boolean; cursor: boolean; primary: boolean; onToggle: (open: boolean) => void;
  /** The rail's row (signals-rail.md 2): two one-line rows, no thesis, the age swapped for `Zanotuj` (or
   * `Odłóż`) and `Potwierdź` on hover, focus inside and the cursor; the decision form opens below. */
  compact?: boolean;
}) {
  const toast = useToast();
  // One request at a time per signal (F7 FE2): a double click must not record two decisions.
  const flight = useInFlight();
  // ...and after a successful write the row stays locked until the reload shows the new state (F7 fix pass F1).
  const stateKey = signalStateKey(s);
  const [lockKey, setLockKey] = useState<string | null>(null);
  const locked = stillLocked(lockKey, stateKey);
  useEffect(() => { if (lockKey != null && lockKey !== stateKey) setLockKey(null); }, [lockKey, stateKey]);
  const busy = flight.busy || locked;
  const names = new Map(ctx.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)]));
  const text = signalText(s, { total: ctx.total, base: ctx.base, names });
  const decided = isDecided(s) ? s.decisions[s.decisions.length - 1] : null;
  const snoozed = !!s.snoozed;
  const quiet = !!decided || snoozed;
  const alert = s.alert_id != null ? ctx.alertsById.get(s.alert_id) : undefined;
  const later = nextDeposit(ctx.today, ctx.contributionDay);
  const pos = s.instrument_id != null ? ctx.positions.find((p) => String(p.instrument.id) === String(s.instrument_id)) ?? null : null;
  const held = pos != null;
  const research = isResearchKind(s.kind) || s.source === "research";
  const noteId = research ? signalNoteId(s) : null;

  // One server-side undo per saved decision, shared by the toast and the "cofnij" link (FX, undo.ts).
  const runUndo = async (u: Undo, what: string, retry: () => void) => {
    const res = await u.undo();
    if (undoSettled(res)) setLockKey(null);
    const msg = undoMessage(res, what);
    if (undoSettled(res)) ctx.onChanged();
    if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
  };
  const offerUndo = (decisionId: number, text: string, what: string) => {
    const u = undoFor(decisionId, Date.now(), () => deleteDecision(ctx.slug, decisionId));
    const retry = () => { void runUndo(u, what, retry); };
    toast(text, 10000, { label: "Cofnij", onClick: retry });
  };
  const decide = (input: DecisionInput, label: string) => locked ? undefined : flight.run(async () => {
    try {
      const r = await postDecision(ctx.slug, s.id, input);
      setLockKey(stateKey);
      onToggle(false);
      ctx.onChanged();
      offerUndo(r.decision.id, `Zapisano decyzję · ${label.replace("decyzja: ", "")}`, "decyzja");
    } catch (e) { toast(`Nie zapisano decyzji: ${errorText(e)}`, 5000); }
  });
  const ackNow = async (reason?: string) => {
    try {
      const r = await postAcknowledge(ctx.slug, s.id, reason);
      setLockKey(stateKey);
      onToggle(false);
      ctx.onChanged();
      offerUndo(r.decision.id, "Potwierdzone bez zmian", "potwierdzenie");
    } catch (e) { toast(`Nie zapisano: ${errorText(e)}`, 5000); }
  };
  const ack = (reason?: string) => { if (!locked) void flight.run(() => ackNow(reason)); };
  const snooze = (until: string) => locked ? undefined : flight.run(async () => {
    try {
      await postSnooze(ctx.slug, s.id, until);
      setLockKey(stateKey);
      ctx.onChanged();
      const u = makeUndo(Date.now(), () => postSnooze(ctx.slug, s.id, null));
      const retry = () => { void runUndo(u, "odłożenie", retry); };
      toast(`Odłożone do ${dm(until)}`, 10000, { label: "Cofnij", onClick: retry });
    } catch (e) {
      // Older servers without the snooze endpoint: the v1 behaviour (acknowledge with a note).
      if (e instanceof ApiError && e.status === 404 && /not found/i.test(e.message)) await ackNow(`odłożone do ${until}`);
      else toast(`Nie odłożono: ${errorText(e)}`, 5000);
    }
  });
  const rowUndo = decided && canUndo(decided) ? () => {
    const u = undoFor(decided.id, parseServerTime(decided.created_at), () => deleteDecision(ctx.slug, decided.id));
    const retry = () => { void runUndo(u, "decyzja", retry); };
    retry();
  } : null;
  // Esc or `Zwiń` in the form: back to the row's first action (keeps the keyboard in place; in the rail the
  // focus reveals the actions).
  const row = useRef<HTMLDivElement>(null);
  const collapse = () => {
    onToggle(false);
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(".act button:not([disabled])")?.focus());
  };
  // A held instrument's title is its identity label (inline: name + muted symbol, details in the hover card).
  const title = pos ? (
    <InstLabel density="inline" inst={pos.instrument} text={text.title} onOpen={() => ctx.onOpenAsset(s.instrument_id!)}
      accounts={pos.accounts.map((a) => { const r = ctx.accounts.find((x) => x.id === a.account_id); return r ? accountLabel(r, ctx.accounts) : `rachunek ${a.account_id}`; })}
      stale={pos.is_stale ? pos.price_date : null} />
  ) : compact ? <span className="nm">{text.title}</span> : text.title;
  const metric = decided ? <><span className="tag solid pos">{decisionTag(decided)}</span>{text.bold ? <> · {text.bold}</> : null}{s.kind === "position_concentration" || s.kind === "allocation_drift" ? " · wraca w podsumowaniu" : ""}
    {rowUndo && <> · <button className="lnk" style={{ fontSize: 12 }} onClick={rowUndo}>cofnij</button></>}</>
    : snoozed ? <><span className="tag solid pos">odłożono{s.snoozed_until ? ` do ${dm(s.snoozed_until)}` : ""}</span>{text.bold ? <> · {text.lead ? `${text.lead} ` : ""}{text.bold}</> : null}</>
    : <>{text.lead ? `${text.lead} ` : ""}{text.bold && <b>{text.bold}</b>}{text.tail ? ` ${text.tail}` : ""}</>;
  const form = <DecisionForm s={s} ctx={ctx} pending={busy} onCollapse={collapse} onDecide={decide} onAck={ack} />;
  const age = ageText(decided?.created_at ?? s.first_seen_at, ctx.today);
  if (compact) {
    return (
      <div ref={row} className={`sig cmp ${quiet ? "quiet" : ""} ${cursor && !open ? "cur" : ""} ${open ? "open" : ""}`} data-signal={s.id}>
        <PolDot polarity={polarityOf(s)} quiet={quiet} />
        <div className="mn">
          {/* A held instrument's title carries the hover card: no native tooltip next to it (FE-A A4). */}
          <div className="t" title={pos ? undefined : [text.title, text.sym].filter(Boolean).join(" ")}>
            {title}
            {!pos && text.sym && <span className="sym">{text.sym}</span>}
            {alert?.source === "agent" && <AgentTag mono text="alert agenta" />}
            {research && <AgentTag mono text="research" />}
          </div>
          <div className="m" title={[text.lead, text.bold, text.tail].filter(Boolean).join(" ")}>{metric}</div>
        </div>
        <div className="rt">
          <span className="when">{age}</span>
          {!quiet && !open && (
            <span className="act">
              {s.kind === "contribution_gap" ? (
                <button className="btn sm primary" disabled={busy} title={`Odłóż do ${dm(later)}`} aria-label={`Odłóż do ${dm(later)}`} onClick={() => snooze(later)}>Odłóż</button>
              ) : <button className="btn sm primary" aria-label="Zanotuj decyzję" onClick={() => onToggle(true)}>Zanotuj</button>}
              <button className="btn sm" disabled={busy} onClick={() => ack()}>Potwierdź</button>
            </span>
          )}
        </div>
        {!quiet && open && <div className="cf">{form}</div>}
      </div>
    );
  }
  return (
    <div ref={row} className={`sig ${quiet ? "quiet" : ""} ${cursor && !open ? "cur" : ""}`} data-signal={s.id}>
      <PolDot polarity={polarityOf(s)} quiet={quiet} />
      <div>
        <div className="t">
          {title}
          {!pos && text.sym && <span className="sym">{text.sym}</span>}
          {alert?.source === "agent" && <AgentTag text="alert agenta" />}
          {research && <AgentTag text="research" />}
        </div>
        <div className="m">{metric}</div>
        {!quiet && thesis && (thesis.thesis || thesis.exit_plan) && (
          <div className="th"><b>Teza ({thesis.created_at ? `${thesis.created_at.slice(5, 7)}.${thesis.created_at.slice(0, 4)}` : "-"})</b> {thesisLine(thesis) || thesis.thesis}</div>
        )}
        {!quiet && (open ? form : (
          <div className="act">
            <button className={`btn sm ${primary ? "primary" : ""}`} onClick={() => onToggle(true)}>Zanotuj decyzję</button>
            <button className="btn sm" disabled={busy} onClick={() => ack()}>Potwierdź</button>
            {s.kind === "contribution_gap" && <button className="btn sm" disabled={busy} onClick={() => snooze(later)}>Odłóż do {dm(later)}</button>}
            {research && ctx.onOpenNote && <button className="lnk" style={{ fontSize: 12 }} onClick={() => ctx.onOpenNote!(s.instrument_id, noteId, typeof s.payload.theme === "string" ? s.payload.theme : null)}>notatka</button>}
          </div>
        ))}
      </div>
      <div className="when">{age}</div>
    </div>
  );
}

const undos = new Map<number, Undo>();
/** The Undo of a saved decision (created once, shared by the toast and the row link). */
function undoFor(decisionId: number, savedAt: number, run: () => Promise<unknown>): Undo {
  let u = undos.get(decisionId);
  if (!u) { u = makeUndo(savedAt, run); undos.set(decisionId, u); }
  return u;
}

function defaultAct(s: SignalV2): Act {
  const kind = s.kind.startsWith("alert:") ? String(s.payload.alert_kind ?? "") : s.kind;
  switch (kind) {
    case "drawdown_from_high": case "loss_from_cost": case "price_below": return "buy";
    case "gain_from_cost": case "position_concentration": case "price_above": return "sell";
    case "allocation_drift": return Number(s.payload.drift_pp) > 0 ? "sell" : "buy";
    default: return "none";
  }
}

export function DecisionForm({ s, ctx, pending, onCollapse, onDecide, onAck }: {
  s: SignalV2; ctx: SignalsCtx; onCollapse: () => void; onDecide: (input: DecisionInput, label: string) => Promise<unknown> | void; onAck: (reason?: string) => void;
  /** A decision / acknowledgement of this signal is being saved (F7 FE2). */
  pending?: boolean;
}) {
  const pos = s.instrument_id != null ? ctx.positions.find((p) => String(p.instrument.id) === String(s.instrument_id)) ?? null : null;
  const [act, setAct] = useState<Act>(() => defaultAct(s));
  const [q, setQ] = useState(() => {
    if (!pos || !pos.price) return "";
    if (s.kind === "position_concentration") {
      const over = (Number(s.payload.weight) - Number(s.payload.max_weight)) * ctx.total;
      return over > 0 ? String(Math.max(1, Math.ceil(over / pos.price))) : "";
    }
    return defaultAct(s) === "buy" ? String(Math.max(1, Math.round(pos.quantity / 3))) : "";
  });
  const [price, setPrice] = useState(() => numInput(pos?.price ?? null));
  const held = pos ? pos.accounts.map((a) => a.account_id) : [];
  const [acc, setAcc] = useState<number | null>(held[0] ?? ctx.accounts[0]?.id ?? null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>(".seg button.on")?.focus(); }, []);
  const trade = act === "buy" || act === "sell";
  const qn = parseNum(q), pn = parseNum(price);
  const currency = pos?.price_currency ?? ctx.base;
  const bucketId = pos?.bucket ?? (s.kind === "allocation_drift" ? String(s.payload.bucket_id) : null);
  const bucket = ctx.buckets.find((b) => b.bucket_id === bucketId) ?? null;
  const effect = trade && pos ? decisionEffect({ side: act === "buy" ? "buy" : "sell", quantity: qn, price: pn, currency, bucket, total: ctx.total, base: ctx.base }) : null;
  const invalid = trade && pos != null && (qn == null || qn <= 0 || pn == null || pn <= 0);
  const save = async () => {
    setBusy(true);
    const input: DecisionInput = { action: ACTION[act], reason: reason.trim() || null, ...(trade && pos ? { quantity: qn, price: pn, currency, account_id: acc } : {}) };
    try { await onDecide(input, decisionTag({ action: ACTION[act], quantity: trade ? qn : null }) ?? "decyzja"); } finally { setBusy(false); }
  };
  return (
    <div className="decide" ref={ref} data-esc-local onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCollapse(); } }}>
      <div className="fr"><label>Decyzja</label>
        <Seg<Act> label="Decyzja" items={[["Nic", "none"], ["Dokupuję", "buy"], ["Sprzedaję", "sell"], ["Odkładam", "later"]]} value={act} onChange={setAct} /></div>
      {s.instrument_id != null && ctx.researchEffect?.(s.instrument_id) && <div className="eff">{ctx.researchEffect(s.instrument_id)}</div>}
      {trade && pos && (
        <>
          <div className="fr">
            <label htmlFor={`dq-${s.id}`}>Ilość</label>
            <input id={`dq-${s.id}`} className="num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
            <label htmlFor={`dp-${s.id}`}>Cena</label>
            <input id={`dp-${s.id}`} className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <label htmlFor={`da-${s.id}`}>Rachunek</label>
            <select id={`da-${s.id}`} value={acc ?? ""} onChange={(e) => setAcc(Number(e.target.value))}>
              {(held.length ? ctx.accounts.filter((a) => held.includes(a.id)) : ctx.accounts).map((a) => <option key={a.id} value={a.id}>{accountLabel(a, ctx.accounts)}</option>)}
            </select>
          </div>
          {effect && <div className="eff">{effect}</div>}
          {pos.quantity > 0 && act === "sell" && qn != null && qn > pos.quantity && <div className="eff warn">Masz {qty(pos.quantity)} szt.</div>}
        </>
      )}
      <textarea rows={2} placeholder="Dlaczego?" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Powód decyzji" />
      <div className="fr">
        <button className="btn primary" onClick={save} disabled={invalid || busy || pending}>Zapisz decyzję</button>
        <button className="btn" disabled={busy || pending} onClick={() => onAck(reason.trim() || undefined)}>Potwierdź</button>
        <span style={{ flex: 1 }} />
        <button className="lnk" onClick={onCollapse}>Zwiń</button>
      </div>
      {trade && pos && <div className="eff">Aplikacja nie składa zleceń: transakcję zapiszesz po wykonaniu.</div>}
    </div>
  );
}

