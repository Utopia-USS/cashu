// Sygnały (home v3: design/v3/home-v3/home-v3.md 6-7 rev 2, owner F8 Q17 / Q18): rule signals and met alerts
// grouped per subject (instrument, bucket, portfolio rule) in two scopes, Portfel (held, portfolio-wide) and
// Obserwowane (watched only). One glyph per subject (chance dot, risk diamond, review square, mixed half dot).
// On the home a rail widget shows up to four live subjects per scope as two-line rows (`TICKER date` + one fact
// per signal); a click (or Enter on the j / k cursor) opens the subject (its asset page, else the dialog at the
// signal), the trailing icon button opens a small menu anchored to it (Zanotuj, Potwierdź, Odłóż, Wszystkie). `Wszystkie (n)` opens the dialog with both scopes as
// columns: the thesis once per subject, a subject's signals as sub-rows with their own actions. A decision is
// saved at once; `Cofnij` in the toast deletes it within the server's 15-minute window (F5 R4).
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { ApiError, isMissingRoute } from "../../../core/api";
import { errorText } from "../../../core/messages";
import { useAsync, useInFlight } from "../../../hooks";
import { Pop, Seg, Skeleton, useModal, useToast } from "../../../ui";
import { PolDot, Widget } from "../../../widgets";
import {
  type AccountRow, type BucketRow, deleteDecision, type DecisionInput, getPositionDetail, postAcknowledge, postDecision, postSnooze, type Thesis,
} from "../api";
import { useShortcuts } from "../hooks";
import { accountLabel, dm, ENTRY_TYPE, numInput, parseNum, plural, qty } from "../labels";
import { decisionEffect, decisionTag, nextDeposit } from "../logic";
import { canUndo, groupUndoRun, makeUndo, type Undo, undoMessage, undoSettled } from "../undo";
import { type Alert, invKey, type PositionV2, postPositionDecision, type SignalV2, type WatchItem } from "./api";
import { staleSignalText, writePositionDecision } from "./decisionFlow";
import { InstLabel, type InstLike } from "./InstLabel";
import {
  cursorOrder, groupPlan, instMono, instName, isDecided, polarityOf, railGroups, type SigFact, signalCurrent, signalFact, signalScope, signalStateKey,
  signalSubject, signalText, splitByPolarity, splitByScope, STATE_LABEL, type SignalFilter, type SignalGroup,
} from "./logic";
import { stillLocked } from "../../../inflight";
import { isResearchKind, signalNoteId } from "./research/logic";
import { localDay, parseServerTime } from "../../../time";

export type { SignalFilter };
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
  /** Instrument ids (strings) held anywhere in the profile: the Portfel / Obserwowane scope (the server's
   * signal `held` wins when sent). */
  held: Set<string>;
  /** The watchlist: names and identity labels of watched instruments; a non-empty list shows Obserwowane. */
  watch?: WatchItem[];
  /** The profile's last non-failed rules run (finished, else started): the unverified-signal fallback. */
  lastRunAt?: string | null;
  /** An instrument's research notes were marked read (the asset drawer's Research section, Q10). */
  onResearchRead?: (instrumentId: number) => void;
}

/** Q18: only the date, `dziś` or `2.10` (never `od 2.10`); an unverified signal shows its last confirmed date in
 * the warn colour (`niepotwierdzony od 1.10`). */
export function signalAge(s: SignalV2, ctx: Pick<SignalsCtx, "today" | "lastRunAt">): { text: string; warn: boolean; title?: string } {
  const decided = isDecided(s) ? s.decisions[s.decisions.length - 1] : null;
  if (!decided && !signalCurrent(s, ctx.lastRunAt ?? null) && s.last_seen_at) {
    const d = dm(s.last_seen_at);
    return { text: d, warn: true, title: `niepotwierdzony od ${d}` };
  }
  const iso = decided?.created_at ?? s.first_seen_at;
  return { text: !iso ? "" : localDay(iso) === ctx.today ? "dziś" : dm(iso), warn: false };
}
export const Age = ({ a }: { a: { text: string; warn: boolean; title?: string } }) => (a.text ? <span className={`age ${a.warn ? "warn" : ""}`} title={a.title}>{a.text}</span> : null);

/** The fact line `{pre} <b>{bold}</b>{post}` (a post starting with a comma joins without a space). */
export const Fact1 = ({ f }: { f: SigFact }) => (
  <>{f.pre ? `${f.pre}${f.bold ? " " : ""}` : ""}{f.bold && <b>{f.bold}</b>}{f.post ? (/^[,.]/.test(f.post) ? f.post : ` ${f.post}`) : ""}</>
);

/** Origin prefix of a fact's tooltip (rev 2 7.2): `alert: `, `alert agenta: `, `research: `. */
function originOf(s: SignalV2, ctx: SignalsCtx): string {
  if (isResearchKind(s.kind) || s.source === "research") return "research: ";
  if (s.alert_id != null || s.kind.startsWith("alert:")) return ctx.alertsById.get(s.alert_id ?? -1)?.source === "agent" ? "alert agenta: " : "alert: ";
  return "";
}
/** The long form of a signal (the fact's tooltip): origin + `signalText` lead / bold / tail. */
export function longText(s: SignalV2, ctx: SignalsCtx): string {
  const t = signalText(s, { total: ctx.total, base: ctx.base, names: namesOf(ctx) });
  return `${originOf(s, ctx)}${[t.lead, t.bold, t.tail].filter(Boolean).join(" ")}`.trim();
}
const namesOf = (ctx: SignalsCtx) => {
  const m = new Map(ctx.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]));
  for (const w of ctx.watch ?? []) if (w.instrument && !m.has(w.instrument_id)) m.set(w.instrument_id, instName(w.instrument));
  return m;
};

/** The instrument of a signal (positions first, then the watchlist) for the identity label. */
function instOf(ctx: SignalsCtx, id: number | null): { inst: InstLike; pos: PositionV2 | null } | null {
  if (id == null) return null;
  const pos = ctx.positions.find((p) => String(p.instrument.id) === String(id)) ?? null;
  if (pos) return { inst: pos.instrument, pos };
  const w = (ctx.watch ?? []).find((x) => x.instrument_id === Number(id));
  return w?.instrument ? { inst: w.instrument, pos: null } : null;
}
const accLabels = (ctx: SignalsCtx, pos: PositionV2 | null) =>
  pos?.accounts.map((a) => { const r = ctx.accounts.find((x) => x.id === a.account_id); return r ? accountLabel(r, ctx.accounts) : `rachunek ${a.account_id}`; });
const subjectInsts = (ctx: SignalsCtx) => {
  const m = new Map<number, { symbol?: string | null; name?: string | null; label: string }>();
  for (const p of ctx.positions) m.set(Number(p.instrument.id), p.instrument);
  for (const w of ctx.watch ?? []) if (w.instrument && !m.has(w.instrument_id)) m.set(w.instrument_id, w.instrument);
  return m;
};

/** Signals with a decision saved in the last 7 days (footer `decyzje: n z m w tym tygodniu`). */
const decidedThisWeek = (list: SignalV2[]) => {
  const weekAgo = Date.now() - 7 * 86400000;
  return list.filter((s) => s.decisions.some((d) => parseServerTime(d.created_at) >= weekAgo)).length;
};

/** j / k move a cursor over `keys` (the item `[attr="key"]` scrolls into view inside `root`), Enter toggles the
 * cursor's item (a decision form) or runs `onEnter` for it (the rail opens the subject); off while `enabled` is false. */
function useCursor<K extends string | number>(keys: K[], root: RefObject<HTMLElement>, enabled: boolean, attr: string, onEnter?: (key: K) => void) {
  const [openId, setOpenId] = useState<K | null>(null);
  const [cursor, setCursor] = useState<K | null>(null);
  const move = (d: number) => {
    if (!keys.length) return;
    const i = keys.findIndex((k) => k === cursor);
    const next = keys[Math.max(0, Math.min(keys.length - 1, i < 0 ? 0 : i + d))];
    setCursor(next);
    const el = root.current?.querySelector<HTMLElement>(`[${attr}="${next}"]`);
    el?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({
    j: () => move(1),
    k: () => move(-1),
    Enter: () => { if (cursor == null) return; if (onEnter) onEnter(cursor); else setOpenId((cur) => (cur === cursor ? null : cursor)); },
  }, enabled);
  return { openId, setOpenId, cursor, setCursor };
}

/** Scroll to `[attr="key"]` inside `root`, flash it once and put the cursor on it (a notification link). */
function useFocusItem<K extends string | number>(key: K | null | undefined, root: RefObject<HTMLElement>, attr: string, setCursor: (k: K) => void) {
  useEffect(() => {
    if (key == null) return;
    setCursor(key);
    const t = setTimeout(() => {
      const el = root.current?.querySelector<HTMLElement>(`[${attr}="${key}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 2600);
    }, 60);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The home's Sygnały rail widget (rev 2 7.1): sections Portfel (always) and Obserwowane (with a watchlist or
 * a watched signal), each with its count of open signals and up to four live subjects; footer = this week's
 * decisions + `Wszystkie (n)` (the dialog). */
export function SignalsRail({ signals, ctx, focusId, onAll, hl, paused }: {
  signals: SignalV2[] | null;
  ctx: SignalsCtx;
  /** A notification link (`?signal=<id>`) to a signal live in one of the rail's rows: scroll, flash, cursor. */
  focusId?: number | null;
  /** `Wszystkie (n)` or a row's `Wszystkie`: open the dialog (at that signal when given). */
  onAll: (focusId?: number | null) => void;
  /** Review step 2 (Sygnały). */
  hl?: boolean;
  /** The dialog is open: its keyboard owns j / k / Enter. */
  paused?: boolean;
}) {
  const list = signals ?? [];
  const held = ctx.held;
  const portfolio = railGroups(list, held, "portfolio");
  const watched = railGroups(list, held, "watched");
  const nScope = (sc: "portfolio" | "watched") => list.filter((s) => signalScope(s, held) === sc).length;
  const showWatched = (ctx.watch?.length ?? 0) > 0 || nScope("watched") > 0;
  const rows = [...portfolio, ...(showWatched ? watched : [])];
  const ref = useRef<HTMLDivElement>(null);
  const openSubject = (g: SignalGroup<SignalV2>) => { if (g.instrumentId != null) ctx.onOpenAsset(g.instrumentId); else onAll(g.primary!.id); };
  const { openId, setOpenId, cursor, setCursor } = useCursor(rows.map((g) => g.key), ref, !paused, "data-group",
    (k) => { const g = rows.find((x) => x.key === k); if (g) openSubject(g); });
  const focusKey = focusId != null ? rows.find((g) => g.live.some((s) => s.id === focusId))?.key ?? null : null;
  useFocusItem(focusKey, ref, "data-group", setCursor);
  const section = (label: string, count: number, groups: SignalGroup<SignalV2>[]) => (
    <div className="rgrp">
      <div className="polh">{label} <span className="cnt">{count}</span></div>
      {groups.length ? groups.map((g) => (
        <GroupRow key={g.key} g={g} ctx={ctx} cursor={cursor === g.key} open={openId === g.key}
          onOpen={(v) => { setOpenId(v ? g.key : null); setCursor(g.key); }} onAll={onAll} onActivate={() => { setCursor(g.key); openSubject(g); }} />
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
          {section("Portfel", nScope("portfolio"), portfolio)}
          {showWatched && section("Obserwowane", nScope("watched"), watched)}
        </div>
      )}
    </Widget>
  );
}

/** One rail row = one subject (rev 2 7.1 + Q17): the glyph, `TICKER date`, one fact per live signal (two lines
 * max, `+n` after the second). A click or Enter opens the subject; the trailing icon button opens the menu; Zanotuj
 * turns the menu into the decision form (decision on the newest signal, the others acknowledged with
 * `decyzja: <tag>`, one undo); Potwierdź acknowledges every live signal (one undo). */
function GroupRow({ g, ctx, cursor, open, onOpen, onAll, onActivate }: {
  g: SignalGroup<SignalV2>; ctx: SignalsCtx; cursor: boolean; open: boolean; onOpen: (open: boolean) => void; onAll: (focusId?: number | null) => void;
  /** A click or Enter on the row: open the subject (asset page, else the dialog at the signal). */
  onActivate: () => void;
}) {
  const toast = useToast();
  const flight = useInFlight();
  const [mode, setMode] = useState<"menu" | "form">("menu");
  const stateKey = g.live.map(signalStateKey).join(";");
  const [lockKey, setLockKey] = useState<string | null>(null);
  const locked = stillLocked(lockKey, stateKey);
  useEffect(() => { if (lockKey != null && lockKey !== stateKey) setLockKey(null); }, [lockKey, stateKey]);
  const busy = flight.busy || locked;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const primary = g.primary!;
  const plan = groupPlan(g);
  const later = nextDeposit(ctx.today, ctx.contributionDay);
  const io = instOf(ctx, g.instrumentId);
  const subject = signalSubject(primary, subjectInsts(ctx));
  const age = signalAge(primary, ctx);
  const lines = g.live.slice(0, 2);
  const more = g.live.length - lines.length;
  useEffect(() => { if (!open) setMode("menu"); }, [open]);
  useEffect(() => {
    if (open && mode === "menu") requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus());
  }, [open, mode]);
  // Focus returns to the menu button after Esc or a menu action (the menu's focused button is gone by then); after
  // an outside click it stays where the click put it (a select, an input), F8 review FE-4.
  const close = () => {
    onOpen(false);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || row.current?.contains(a)) (trigger.current ?? row.current)?.focus({ preventScroll: true });
    });
  };

  const offer = (ids: number[], text: string, what: string) => {
    if (!ids.length) return;
    const u = makeUndo(Date.now(), groupUndoRun(ids, (id) => deleteDecision(ctx.slug, id)));
    const retry = () => {
      void u.undo().then((res) => {
        if (undoSettled(res)) { setLockKey(null); ctx.onChanged(); }
        const msg = undoMessage(res, what);
        if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
      });
    };
    toast(text, 10000, { label: "Cofnij", onClick: retry });
  };
  /** Writes in order; a failure keeps what was saved (with its undo) and says so. */
  const writeAll = (steps: (() => Promise<{ decision: { id: number } }>)[], text: string, what: string, failText: string) => locked ? undefined : flight.run(async () => {
    const ids: number[] = [];
    try {
      for (const step of steps) ids.push((await step()).decision.id);
      setLockKey(stateKey);
      close();
      ctx.onChanged();
      offer(ids, text, what);
    } catch (e) {
      if (ids.length) { ctx.onChanged(); offer(ids, `${failText}: ${errorText(e)}`, what); } else toast(`${failText}: ${errorText(e)}`, 5000);
    }
  });
  const decide = (input: DecisionInput, label: string) => {
    if (!plan) return;
    const tag = label.replace("decyzja: ", "");
    return writeAll(fanOutSteps(ctx.slug, plan.primary, plan.rest, input, tag), `Zapisano decyzję · ${tag}`, "decyzja", "Nie zapisano decyzji");
  };
  const ack = (reason?: string) => { void writeAll(g.live.map((x) => () => postAcknowledge(ctx.slug, x.id, reason)), "Potwierdzone bez zmian", "potwierdzenie", "Nie zapisano"); };
  const snooze = () => locked ? undefined : flight.run(async () => {
    try {
      await postSnooze(ctx.slug, primary.id, later);
      setLockKey(stateKey);
      close();
      ctx.onChanged();
      const u = makeUndo(Date.now(), () => postSnooze(ctx.slug, primary.id, null));
      const retry = () => {
        void u.undo().then((res) => {
          if (undoSettled(res)) { setLockKey(null); ctx.onChanged(); }
          const msg = undoMessage(res, "odłożenie");
          if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
        });
      };
      toast(`Odłożone do ${dm(later)}`, 10000, { label: "Cofnij", onClick: retry });
    } catch (e) {
      // Older servers without the snooze endpoint: the v1 behaviour (acknowledge with a note).
      if (e instanceof ApiError && e.status === 404 && /not found/i.test(e.message)) {
        try { const r = await postAcknowledge(ctx.slug, primary.id, `odłożone do ${later}`); setLockKey(stateKey); close(); ctx.onChanged(); offer([r.decision.id], "Potwierdzone bez zmian", "potwierdzenie"); }
        catch (e2) { toast(`Nie odłożono: ${errorText(e2)}`, 5000); }
      } else toast(`Nie odłożono: ${errorText(e)}`, 5000);
    }
  });
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const tk = io ? (
    <InstLabel density="inline" inst={io.inst} text={subject} accounts={accLabels(ctx, io.pos)} stale={io.pos?.is_stale ? io.pos.price_date : null} />
  ) : subject;
  const name = io ? instName(io.inst) : subject;
  const label = `${name}: ${g.live.map((x) => [signalFact(x).pre, signalFact(x).bold, signalFact(x).post].filter(Boolean).join(" ")).join("; ")}`;
  return (
    <div ref={row} role="link" tabIndex={0} aria-label={label}
      className={`sig cmp row ${g.live.length > 1 ? "grp" : ""} ${cursor && !open ? "cur" : ""} ${open ? "open" : ""}`} data-signal={primary.id} data-group={g.key}
      onClick={(e) => { if (!(e.target as HTMLElement).closest(".pop, .rt")) onActivate(); }}
      onKeyDown={(e) => { if (e.target === row.current && e.key === "Enter") { e.preventDefault(); onActivate(); } }}>
      <PolDot state={g.state} title={STATE_LABEL[g.state]} />
      <div className="mn">
        <div className="t"><span className="tk">{tk}</span><Age a={age} /></div>
        {lines.map((x, i) => (
          <div key={x.id} className="m f" title={longText(x, ctx)}><Fact1 f={signalFact(x)} />{i === lines.length - 1 && more > 0 && <span className="more">+{more}</span>}</div>
        ))}
      </div>
      <div className="rt">
        <button ref={trigger} className="icon-btn quiet rmore" aria-haspopup="menu" aria-expanded={open} aria-label={`Akcje: ${name}`} title="Akcje"
          onClick={() => onOpen(!open)}>⋯</button>
      {/* keyed by mode: the form is taller than the menu, so it is placed again */}
      <Pop key={mode} portal open={open} onClose={close} width={mode === "form" ? 460 : 220} align="right" label={name}>
        {mode === "menu" ? (
          <div className="rmenu" role="menu" aria-label={name} ref={menu} onKeyDown={onMenuKey}>
            <button role="menuitem" disabled={busy} onClick={() => setMode("form")}>Zanotuj</button>
            <button role="menuitem" disabled={busy} onClick={() => ack()}>Potwierdź{g.live.length > 1 && <span className="hint">{g.live.length}</span>}</button>
            {primary.kind === "contribution_gap" && <button role="menuitem" disabled={busy} onClick={() => void snooze()}>Odłóż<span className="hint">do {dm(later)}</span></button>}
            <div className="sep" role="separator" />
            <button role="menuitem" onClick={() => { onOpen(false); onAll(primary.id); }}>Wszystkie</button>
          </div>
        ) : (
          <div className="rform">
            <div className="rfh"><b>{subject}</b> · <Fact1 f={signalFact(primary)} />{g.live.length > 1 ? ` · +${plural(g.live.length - 1, "sygnał potwierdzony", "sygnały potwierdzone", "sygnałów potwierdzonych")}` : ""}</div>
            <DecisionForm s={primary} ctx={ctx} pending={busy} onCollapse={close} onDecide={decide} onAck={ack} />
          </div>
        )}
      </Pop>
      </div>
    </div>
  );
}

/** All open signals (rev 2 7.4): a centered modal with the scope columns (Portfel 2/3, Obserwowane 1/3; one
 * column without a watchlist), a polarity filter and the footer (decisions this week, expired since the last
 * review, the journal). Review mode: the cursor on the first undecided signal, `bez decyzji: n`. Leaving to an
 * asset, a note or the journal closes it first. */
export function SignalsDialog({ signals, ctx, filter: initial = "all", focusId, review, expired, onHistory, onClose }: {
  signals: SignalV2[];
  ctx: SignalsCtx;
  filter?: SignalFilter;
  /** A signal to land on (a notification link, a rail row's `Wszystkie`): scroll, flash, cursor. */
  focusId?: number | null;
  review?: boolean;
  /** Signals that expired since the last review (digest), for the footer. */
  expired?: { title: string }[];
  onHistory: () => void;
  onClose: () => void;
}) {
  const list = signals;
  const held = ctx.held;
  const { positive, negative } = splitByPolarity(list);
  const [filter, setFilter] = useState<SignalFilter>(initial);
  const cols = splitByScope(list, held, filter);
  const twoCols = (ctx.watch?.length ?? 0) > 0 || list.some((s) => signalScope(s, held) === "watched");
  const order = cursorOrder(list, held, filter);
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, true, onClose, { focus: "panel" });
  const { openId, setOpenId, cursor, setCursor } = useCursor(order.map((s) => s.id), ref, true, "data-signal");
  const theses = useTheses(ctx.slug, list, ctx.positions);
  // Review step 2 puts the cursor on the first undecided signal.
  useEffect(() => { if (review && focusId == null && order[0]) setCursor(order[0].id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusItem(focusId != null && list.some((s) => s.id === focusId) ? focusId : null, ref, "data-signal", setCursor);
  const leave = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { onClose(); fn(...a); };
  const dctx: SignalsCtx = { ...ctx, onOpenAsset: leave(ctx.onOpenAsset), onOpenNote: ctx.onOpenNote && leave(ctx.onOpenNote) };
  const decided = list.filter(isDecided).length;
  const first = order[0]?.id ?? -1;
  const item = (s: SignalV2, sub: boolean) => (
    <SignalItem key={s.id} s={s} ctx={dctx} thesis={!sub && s.instrument_id != null ? theses.get(s.instrument_id) ?? null : null} sub={sub}
      open={openId === s.id} cursor={cursor === s.id} primary={s.id === first}
      onToggle={(v) => { setOpenId(v ? s.id : null); if (v) setCursor(s.id); }} />
  );
  const group = (g: SignalGroup<SignalV2>) => {
    if (g.signals.length === 1) return item(g.signals[0], false);
    const head = g.primary ?? g.signals[0];
    const io = instOf(dctx, g.instrumentId);
    const t = theses.get(g.instrumentId ?? -1) ?? null;
    return (
      <div key={g.key} className={`sig grp ${g.settled ? "quiet" : ""}`} data-group={g.key}>
        <PolDot state={g.state} title={STATE_LABEL[g.state]} quiet={g.settled} />
        <div>
          <SubjectTitle s={head} ctx={dctx} io={io} extra={<span className="nmm">{plural(g.signals.length, "sygnał", "sygnały", "sygnałów")}</span>} />
          {!g.settled && t && (t.thesis || t.exit_plan) && <ThesisLine t={t} />}
          {[...g.live, ...g.signals.filter((x) => !g.live.includes(x))].map((x) => item(x, true))}
        </div>
      </div>
    );
  };
  const col = (label: string, groups: SignalGroup<SignalV2>[], count: number) => (
    <div>
      <div className="polh">{label} <span className="cnt">{count}</span></div>
      {groups.length ? groups.map(group) : <div className="muted" style={{ fontSize: 12.5, padding: "8px 0" }}>Brak</div>}
    </div>
  );
  const count = (gs: SignalGroup<SignalV2>[]) => gs.reduce((a, g) => a + g.signals.length, 0);
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
          {!list.length ? <div className="empty">Brak otwartych sygnałów.</div> : twoCols ? (
            <div className="scope2">{col("Portfel", cols.portfolio, count(cols.portfolio))}{col("Obserwowane", cols.watched, count(cols.watched))}</div>
          ) : col("Portfel", cols.portfolio, count(cols.portfolio))}
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

/** A dialog row's title (rev 2 7.4): the ticker (bold, the identity label's hover card; opens the asset), the
 * muted full name and the date; portfolio subjects: the signal's title + date. */
function SubjectTitle({ s, ctx, io, extra }: { s: SignalV2; ctx: SignalsCtx; io: { inst: InstLike; pos: PositionV2 | null } | null; extra?: ReactNode }) {
  const age = signalAge(s, ctx);
  if (io) {
    const name = instName(io.inst);
    const ticker = io.inst.symbol ? instMono({ symbol: io.inst.symbol, name, label: name }) : name;
    return (
      <div className="t">
        <span className="tk"><InstLabel density="inline" inst={io.inst} text={ticker} onOpen={() => ctx.onOpenAsset(Number(io.inst.id))}
          accounts={accLabels(ctx, io.pos)} stale={io.pos?.is_stale ? io.pos.price_date : null} /></span>
        {ticker !== name && <span className="nmm">{name}</span>}
        {extra}
        <Age a={age} />
      </div>
    );
  }
  const t = signalText(s, { total: ctx.total, base: ctx.base, names: namesOf(ctx) });
  return <div className="t"><span>{t.title}</span>{t.sym && <span className="sym">{t.sym}</span>}{extra}<Age a={age} /></div>;
}

const ThesisLine = ({ t }: { t: Thesis }) => (
  <div className="th"><b>Teza ({t.created_at ? `${t.created_at.slice(5, 7)}.${t.created_at.slice(0, 4)}` : "-"})</b> {thesisLine(t) || t.thesis}</div>
);

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

/** A signal in the dialog or on the asset page (rev 2 7.4): the title line (ticker, name, date), one fact (the
 * long form in its tooltip), the thesis, the actions in place (Zanotuj decyzję, Potwierdź, Odłóż do …, notatka)
 * or the decision form. `sub`: a sub-row of a multi-signal subject (small glyph, the fact + date, its actions). */
export function SignalItem({ s, ctx, thesis, open, cursor, primary, onToggle, sub }: {
  s: SignalV2; ctx: SignalsCtx; thesis: Thesis | null; open: boolean; cursor: boolean; primary: boolean; onToggle: (open: boolean) => void;
  sub?: boolean;
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
  const decided = isDecided(s) ? s.decisions[s.decisions.length - 1] : null;
  const snoozed = !!s.snoozed;
  const quiet = !!decided || snoozed;
  const later = nextDeposit(ctx.today, ctx.contributionDay);
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
  // Esc or `Zwiń` in the form: back to the row's first action (keeps the keyboard in place).
  const row = useRef<HTMLDivElement>(null);
  const collapse = () => {
    onToggle(false);
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>(".act button:not([disabled])")?.focus());
  };
  const fact = signalFact(s);
  const metric = decided ? <><span className="tag solid pos">{decisionTag(decided)}</span>{fact.bold ? <> · {fact.bold}</> : null}{s.kind === "position_concentration" || s.kind === "allocation_drift" ? " · wraca w podsumowaniu" : ""}
    {rowUndo && <> · <button className="lnk" style={{ fontSize: 12 }} onClick={rowUndo}>cofnij</button></>}</>
    : snoozed ? <><span className="tag solid pos">odłożono{s.snoozed_until ? ` do ${dm(s.snoozed_until)}` : ""}</span>{fact.bold ? <> · <Fact1 f={fact} /></> : null}</>
    : <Fact1 f={fact} />;
  const form = <DecisionForm s={s} ctx={ctx} pending={busy} onCollapse={collapse} onDecide={decide} onAck={ack} />;
  const actions = !quiet && (open ? form : (
    <div className="act">
      <button className={`btn sm ${primary ? "primary" : ""}`} onClick={() => onToggle(true)}>Zanotuj decyzję</button>
      <button className="btn sm" disabled={busy} onClick={() => ack()}>Potwierdź</button>
      {s.kind === "contribution_gap" && <button className="btn sm" disabled={busy} onClick={() => snooze(later)}>Odłóż do {dm(later)}</button>}
      {research && ctx.onOpenNote && <button className="lnk" style={{ fontSize: 12 }} onClick={() => ctx.onOpenNote!(s.instrument_id, noteId, typeof s.payload.theme === "string" ? s.payload.theme : null)}>notatka</button>}
    </div>
  ));
  if (sub) {
    return (
      <div ref={row} className={`sub-sig ${quiet ? "quiet" : ""} ${cursor && !open ? "cur" : ""}`} data-signal={s.id}>
        <PolDot polarity={polarityOf(s)} quiet={quiet} />
        <div>
          <div className="m" title={longText(s, ctx)}>{metric} <Age a={signalAge(s, ctx)} /></div>
          {actions}
        </div>
      </div>
    );
  }
  return (
    <div ref={row} className={`sig ${quiet ? "quiet" : ""} ${cursor && !open ? "cur" : ""}`} data-signal={s.id}>
      <PolDot polarity={polarityOf(s)} quiet={quiet} />
      <div>
        <SubjectTitle s={s} ctx={ctx} io={instOf(ctx, s.instrument_id)} />
        <div className="m" title={longText(s, ctx)}>{metric}</div>
        {!quiet && thesis && (thesis.thesis || thesis.exit_plan) && <ThesisLine t={thesis} />}
        {actions}
      </div>
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

function defaultAct(s: SignalV2 | null | undefined): Act {
  if (!s) return "none";
  const kind = s.kind.startsWith("alert:") ? String(s.payload.alert_kind ?? "") : s.kind;
  switch (kind) {
    case "drawdown_from_high": case "loss_from_cost": case "price_below": return "buy";
    case "gain_from_cost": case "position_concentration": case "price_above": return "sell";
    case "allocation_drift": return Number(s.payload.drift_pp) > 0 ? "sell" : "buy";
    default: return "none";
  }
}

export function DecisionForm({ s = null, instrumentId = null, ctx, pending, hideAck, onCollapse, onDecide, onAck }: {
  /** The signal the decision answers (its default action and quantity); null for a position decision without one. */
  s?: SignalV2 | null;
  /** The instrument when there is no signal (the asset's decision dialog, asset-detail.md 7.2). */
  instrumentId?: number | null;
  ctx: SignalsCtx; onCollapse: () => void; onDecide: (input: DecisionInput, label: string) => Promise<unknown> | void; onAck?: (reason?: string) => void;
  /** A decision / acknowledgement of this signal is being saved (F7 FE2). */
  pending?: boolean;
  /** No `Potwierdź` button (the asset's dialog records a decision; acknowledging is the row's link). */
  hideAck?: boolean;
}) {
  const instId = s?.instrument_id ?? instrumentId;
  const pos = instId != null ? ctx.positions.find((p) => String(p.instrument.id) === String(instId)) ?? null : null;
  const [act, setAct] = useState<Act>(() => defaultAct(s));
  const [q, setQ] = useState(() => {
    if (!pos || !pos.price || !s) return "";
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
  const bucketId = pos?.bucket ?? (s?.kind === "allocation_drift" ? String(s.payload.bucket_id) : null);
  const fid = s?.id ?? `p${instId}`;
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
      {instId != null && ctx.researchEffect?.(instId) && <div className="eff">{ctx.researchEffect(instId)}</div>}
      {trade && pos && (
        <>
          <div className="fr">
            <label htmlFor={`dq-${fid}`}>Ilość</label>
            <input id={`dq-${fid}`} className="num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
            <label htmlFor={`dp-${fid}`}>Cena</label>
            <input id={`dp-${fid}`} className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <label htmlFor={`da-${fid}`}>Rachunek</label>
            <select id={`da-${fid}`} value={acc ?? ""} onChange={(e) => setAcc(Number(e.target.value))}>
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
        {!hideAck && onAck && <button className="btn" disabled={busy || pending} onClick={() => onAck(reason.trim() || undefined)}>Potwierdź</button>}
        <span style={{ flex: 1 }} />
        <button className="lnk" onClick={onCollapse}>Zwiń</button>
      </div>
      {trade && pos && <div className="eff">Aplikacja nie składa zleceń: transakcję zapiszesz po wykonaniu.</div>}
    </div>
  );
}


// ---- the asset's one decision and its row acknowledgement (asset-detail.md 7.1-7.2, F9) --------------------

/** The home's fan-out for servers without position decisions: the decision on the primary signal, `decyzja:
 * <tag>` acknowledgements on the rest (one journal act, n rows; one undo deletes them all). */
export function fanOutSteps(slug: string, primary: SignalV2, rest: SignalV2[], input: DecisionInput, tag: string): (() => Promise<{ decision: { id: number } }>)[] {
  return [() => postDecision(slug, primary.id, input), ...rest.map((x) => () => postAcknowledge(slug, x.id, `decyzja: ${tag}`))];
}

/** Profiles whose server answered `POST /positions/{id}/decision` with a missing route (this session). */
const legacyServers = new Set<string>();
/** The server has no position decisions: a decision needs an open signal (the header button turns disabled). */
export const legacyDecisions = (slug: string) => legacyServers.has(slug);

function useUndoToast(ctx: Pick<SignalsCtx, "onChanged">, onUndone?: () => void) {
  const toast = useToast();
  return (ids: number[], text: string, what: string, slug: string) => {
    if (!ids.length) return;
    const u = makeUndo(Date.now(), groupUndoRun(ids, (id) => deleteDecision(slug, id)));
    const retry = () => {
      void u.undo().then((res) => {
        if (undoSettled(res)) { onUndone?.(); ctx.onChanged(); }
        const msg = undoMessage(res, what);
        if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
      });
    };
    toast(text, 10000, { label: "Cofnij", onClick: retry });
  };
}

/** One decision per position (7.2): `POST /positions/{id}/decision` linked to every listed signal; on an older
 * server the fan-out above (a decision without signals cannot be saved there). The tree is `writePositionDecision`
 * (decisionFlow.ts, tested); this maps its outcome to one toast with one `Cofnij`. Resolves "saved" (the dialog
 * closes), "close" (nothing saved but the dialog has nothing more to offer: an older server without an open
 * signal) or "stay" (a failure; the dialog stays for a retry). */
export function useDecisionWriter(ctx: SignalsCtx) {
  const toast = useToast();
  const flight = useInFlight();
  const offer = useUndoToast(ctx);
  const save = async (instrumentId: number, signals: SignalV2[], input: DecisionInput, label: string): Promise<"saved" | "close" | "stay"> => {
    const r = await flight.run(async () => {
      const tag = label.replace("decyzja: ", "");
      const out = await writePositionDecision({
        legacy: legacyServers.has(ctx.slug),
        post: () => postPositionDecision(ctx.slug, instrumentId, { ...input, signal_ids: signals.map((x) => x.id) }),
        fanOut: signals.length ? fanOutSteps(ctx.slug, signals[0], signals.slice(1), input, tag) : [],
        isMissingRoute,
      });
      if (out.legacy) legacyServers.add(ctx.slug);
      switch (out.kind) {
        case "saved": ctx.onChanged(); offer(out.ids, `Zapisano decyzję · ${tag}`, "decyzja", ctx.slug); return "saved" as const;
        case "partial": ctx.onChanged(); offer(out.ids, `Nie zapisano decyzji: ${errorText(out.error)}`, "decyzja", ctx.slug); return "saved" as const;
        case "needs-signal": toast("Nie zapisano: starszy serwer wymaga otwartego sygnału", 5000); return "close" as const;
        default: {
          const stale = staleSignalText(out.error);
          // The open signals changed since the list loaded: reload them (the dialog's list refreshes) and say so.
          if (stale) { ctx.onChanged(); toast(stale, 5000); } else toast(`Nie zapisano decyzji: ${errorText(out.error)}`, 5000);
          return "stay" as const;
        }
      }
    });
    return r ?? "stay";
  };
  return { save, busy: flight.busy };
}

/** `potwierdź` on an asset's open row (7.1): acknowledge one signal with the in-flight lock and the post-write
 * lock of `SignalItem` (the row stays locked until the reload shows its new state), toast + `Cofnij`. */
export function useSignalAck(ctx: SignalsCtx) {
  const toast = useToast();
  const flight = useInFlight();
  const [locks, setLocks] = useState<Record<number, string>>({});
  const offer = useUndoToast(ctx, () => setLocks({}));
  const busy = (s: SignalV2) => flight.busy || stillLocked(locks[s.id] ?? null, signalStateKey(s));
  const ack = (s: SignalV2) => {
    if (busy(s)) return;
    void flight.run(async () => {
      try {
        const r = await postAcknowledge(ctx.slug, s.id);
        setLocks((l) => ({ ...l, [s.id]: signalStateKey(s) }));
        ctx.onChanged();
        offer([r.decision.id], "Potwierdzone bez zmian", "potwierdzenie", ctx.slug);
      } catch (e) { toast(`Nie zapisano: ${errorText(e)}`, 5000); }
    });
  };
  return { ack, busy };
}
