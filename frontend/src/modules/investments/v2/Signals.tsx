// Sygnały (ia-v2.md 6, F-01/F-05): rule signals and triggered alerts in one list, two columns by polarity
// (Szanse | Ryzyka i przegląd), plain words instead of rule ids, the thesis under the signal that fired,
// actions in place (Zanotuj decyzję, Potwierdź, Odłóż do …), decided items quiet at the bottom. A decision
// is saved at once; `Cofnij` in the toast deletes it within the server's 15-minute window (F5 R4).
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../core/api";
import { useAsync } from "../../../hooks";
import { Seg, useToast } from "../../../ui";
import { AgentTag, PolDot, Widget } from "../../../widgets";
import {
  type AccountRow, type BucketRow, deleteDecision, type DecisionInput, getPositionDetail, postAcknowledge, postDecision, postSnooze, type Thesis,
} from "../api";
import { useShortcuts } from "../hooks";
import { accountLabel, dm, ENTRY_TYPE, numInput, parseNum, plural, qty } from "../labels";
import { decisionEffect, decisionTag, nextDeposit } from "../logic";
import { canUndo, makeUndo, type Undo, undoMessage } from "../undo";
import type { Alert, PositionV2, SignalV2 } from "./api";
import { cursorOrder, instName, isDecided, polarityOf, signalText, splitByPolarity } from "./logic";

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
}

const ageText = (iso: string | null, today: string) => (!iso ? "" : iso.slice(0, 10) === today ? "dziś" : `od ${dm(iso)}`);

export function SignalsWidget({ signals, ctx, hl, review, expired, onHistory }: {
  signals: SignalV2[] | null;
  ctx: SignalsCtx;
  hl?: boolean;
  review?: boolean;
  /** Signals that expired since the last review (digest), for the footer. */
  expired?: { title: string }[];
  onHistory: () => void;
}) {
  const list = signals ?? [];
  const { positive, negative } = splitByPolarity(list);
  const [openId, setOpenId] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const theses = useTheses(ctx.slug, list, ctx.positions);
  const decided = list.filter(isDecided).length;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const decidedWeek = list.filter((s) => s.decisions.some((d) => (d.created_at ?? "") >= weekAgo)).length;
  const order = cursorOrder(list);
  const move = (d: number) => {
    if (!order.length) return;
    const i = order.findIndex((s) => s.id === cursor);
    const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + d))];
    setCursor(next.id);
    document.querySelector(`[data-signal="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({
    j: () => move(1),
    k: () => move(-1),
    Enter: () => { if (cursor != null) setOpenId((cur) => (cur === cursor ? null : cursor)); },
  });
  // Review step 2 focuses the first undecided signal.
  useEffect(() => { if (review && hl && cursor == null && order[0]) setCursor(order[0].id); }, [review, hl]); // eslint-disable-line react-hooks/exhaustive-deps
  const col = (items: SignalV2[]) => items.map((s) => (
    <SignalItem key={s.id} s={s} ctx={ctx} thesis={s.instrument_id != null ? theses.get(s.instrument_id) ?? null : null}
      open={openId === s.id} cursor={cursor === s.id} primary={s.id === (order[0]?.id ?? -1)}
      onToggle={(v) => { setOpenId(v ? s.id : null); if (v) setCursor(s.id); }} />
  ));
  const undecided = list.length - decided;
  return (
    <Widget title="Sygnały" id="inv-signals" hl={hl} count={list.length || undefined}
      tags={review && decided > 0 ? <span className="tag solid pos">{plural(decided, "rozstrzygnięty", "rozstrzygnięte", "rozstrzygniętych")}</span> : undefined}
      controls={review ? <span className="muted" style={{ fontSize: 12 }}>j / k: następny · Enter: decyzja</span> : <button className="lnk" onClick={onHistory}>historia i dziennik decyzji</button>}
      body="tight"
      footer={review ? (
        <><span>bez decyzji: <b>{undecided}</b>{undecided ? " · można zamknąć, wrócą w podsumowaniu" : ""}</span><span className="spacer" /><span>Esc zwija formularz</span></>
      ) : (
        <>
          <span>decyzje: <b>{decidedWeek} z {list.length}</b> w tym tygodniu</span>
          {expired && expired.length > 0 && <span>{plural(expired.length, "sygnał wygasł", "sygnały wygasły", "sygnałów wygasło")} ({expired.slice(0, 2).map((e) => e.title).join(", ")})</span>}
          <span className="spacer" /><span>sygnały z reguł i wyzwolonych alertów</span>
        </>
      )}>
      {!signals ? <div className="skeleton" style={{ height: 140 }} /> : !list.length ? (
        <div className="empty">Brak otwartych sygnałów. Reguły i alerty sprawdzają portfel przy każdym przebiegu.</div>
      ) : (
        <div className="pol2">
          <div>
            <div className="polh"><PolDot polarity="positive" />Szanse <span className="cnt">{positive.length}</span></div>
            {positive.length ? col(positive) : <div className="muted" style={{ fontSize: 12.5, padding: "8px 0" }}>Brak szans według Twoich reguł.</div>}
          </div>
          <div>
            <div className="polh"><PolDot polarity="negative" />Ryzyka i przegląd <span className="cnt">{negative.length}</span></div>
            {negative.length ? col(negative) : <div className="muted" style={{ fontSize: 12.5, padding: "8px 0" }}>Brak ryzyk do przejrzenia.</div>}
          </div>
        </div>
      )}
    </Widget>
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
  }, [slug, ids.join(",")]);
  return q.data ?? new Map();
}

function thesisLine(t: Thesis): string {
  return [t.entry_type ? ENTRY_TYPE[t.entry_type] ?? t.entry_type : null, t.size_plan, t.exit_plan ? `wyjście ${t.exit_plan}` : null].filter(Boolean).join(" · ");
}

export function SignalItem({ s, ctx, thesis, open, cursor, primary, onToggle }: {
  s: SignalV2; ctx: SignalsCtx; thesis: Thesis | null; open: boolean; cursor: boolean; primary: boolean; onToggle: (open: boolean) => void;
}) {
  const toast = useToast();
  const names = new Map(ctx.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)]));
  const text = signalText(s, { total: ctx.total, base: ctx.base, names });
  const decided = isDecided(s) ? s.decisions[s.decisions.length - 1] : null;
  const snoozed = !!s.snoozed;
  const quiet = !!decided || snoozed;
  const alert = s.alert_id != null ? ctx.alertsById.get(s.alert_id) : undefined;
  const later = nextDeposit(ctx.today, ctx.contributionDay);
  const held = s.instrument_id != null && ctx.positions.some((p) => String(p.instrument.id) === String(s.instrument_id));

  // One server-side undo per saved decision, shared by the toast and the "cofnij" link (FX, undo.ts).
  const runUndo = async (u: Undo, what: string, retry: () => void) => {
    const res = await u.undo();
    const msg = undoMessage(res, what);
    if (res === "done") ctx.onChanged();
    if (msg) toast(msg, res === "failed" ? 8000 : 3000, res === "failed" ? { label: "Cofnij", onClick: retry } : undefined);
  };
  const offerUndo = (decisionId: number, text: string, what: string) => {
    const u = undoFor(decisionId, Date.now(), () => deleteDecision(ctx.slug, decisionId));
    const retry = () => { void runUndo(u, what, retry); };
    toast(text, 10000, { label: "Cofnij", onClick: retry });
  };
  const decide = async (input: DecisionInput, label: string) => {
    try {
      const r = await postDecision(ctx.slug, s.id, input);
      onToggle(false);
      ctx.onChanged();
      offerUndo(r.decision.id, `Zapisano decyzję · ${label.replace("decyzja: ", "")}`, "decyzja");
    } catch (e) { toast(`Nie zapisano decyzji: ${(e as Error).message}`, 5000); }
  };
  const ack = async (reason?: string) => {
    try {
      const r = await postAcknowledge(ctx.slug, s.id, reason);
      onToggle(false);
      ctx.onChanged();
      offerUndo(r.decision.id, "Potwierdzone bez zmian", "potwierdzenie");
    } catch (e) { toast(`Nie zapisano: ${(e as Error).message}`, 5000); }
  };
  const snooze = async (until: string) => {
    try {
      await postSnooze(ctx.slug, s.id, until);
      ctx.onChanged();
      const u = makeUndo(Date.now(), () => postSnooze(ctx.slug, s.id, null));
      const retry = () => { void runUndo(u, "odłożenie", retry); };
      toast(`Odłożone do ${dm(until)}`, 10000, { label: "Cofnij", onClick: retry });
    } catch (e) {
      // Older servers without the snooze endpoint: the v1 behaviour (acknowledge with a note).
      if (e instanceof ApiError && e.status === 404 && /not found/i.test(e.message)) await ack(`odłożone do ${until}`);
      else toast(`Nie odłożono: ${(e as Error).message}`, 5000);
    }
  };
  const rowUndo = decided && canUndo(decided) ? () => {
    const u = undoFor(decided.id, Date.parse(decided.created_at!), () => deleteDecision(ctx.slug, decided.id));
    const retry = () => { void runUndo(u, "decyzja", retry); };
    retry();
  } : null;
  return (
    <div className={`sig ${quiet ? "quiet" : ""} ${cursor && !open ? "cur" : ""}`} data-signal={s.id}>
      <PolDot polarity={polarityOf(s)} quiet={quiet} />
      <div>
        <div className="t">
          {held ? <button className="nm" onClick={() => ctx.onOpenAsset(s.instrument_id!)}>{text.title}</button> : text.title}
          {text.sym && <span className="sym">{text.sym}</span>}
          {alert?.source === "agent" && <AgentTag text="alert agenta" />}
        </div>
        <div className="m">
          {decided ? <><span className="tag solid pos">{decisionTag(decided)}</span>{text.bold ? <> · {text.bold}</> : null}{s.kind === "position_concentration" || s.kind === "allocation_drift" ? " · wraca w podsumowaniu" : ""}
            {rowUndo && <> · <button className="lnk" style={{ fontSize: 12 }} onClick={rowUndo}>cofnij</button></>}</>
            : snoozed ? <><span className="tag solid pos">odłożono{s.snoozed_until ? ` do ${dm(s.snoozed_until)}` : ""}</span>{text.bold ? <> · {text.lead ? `${text.lead} ` : ""}{text.bold}</> : null}</>
            : <>{text.lead ? `${text.lead} ` : ""}{text.bold && <b>{text.bold}</b>}{text.tail ? ` ${text.tail}` : ""}</>}
        </div>
        {!quiet && thesis && (thesis.thesis || thesis.exit_plan) && (
          <div className="th"><b>Teza ({thesis.created_at ? `${thesis.created_at.slice(5, 7)}.${thesis.created_at.slice(0, 4)}` : "-"})</b> {thesisLine(thesis) || thesis.thesis}</div>
        )}
        {!quiet && (open ? (
          <DecisionForm s={s} ctx={ctx} onCollapse={() => onToggle(false)} onDecide={decide} onAck={ack} />
        ) : (
          <div className="act">
            <button className={`btn sm ${primary ? "primary" : ""}`} onClick={() => onToggle(true)}>Zanotuj decyzję</button>
            <button className="btn sm" onClick={() => ack()}>Potwierdź</button>
            {s.kind === "contribution_gap" && <button className="btn sm" onClick={() => snooze(later)}>Odłóż do {dm(later)}</button>}
          </div>
        ))}
      </div>
      <div className="when">{ageText(decided?.created_at ?? s.first_seen_at, ctx.today)}</div>
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

export function DecisionForm({ s, ctx, onCollapse, onDecide, onAck }: {
  s: SignalV2; ctx: SignalsCtx; onCollapse: () => void; onDecide: (input: DecisionInput, label: string) => void; onAck: (reason?: string) => void;
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
    <div className="decide" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCollapse(); } }}>
      <div className="fr"><label>Co robię?</label>
        <Seg<Act> label="Co robię?" items={[["Nic", "none"], ["Dokupuję", "buy"], ["Sprzedaję", "sell"], ["Odkładam", "later"]]} value={act} onChange={setAct} /></div>
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
      <textarea rows={2} placeholder="Dlaczego? Jedno-dwa zdania, trafią do dziennika." value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Powód decyzji" />
      <div className="fr">
        <button className="btn primary" onClick={save} disabled={invalid || busy}>Zapisz decyzję</button>
        <button className="btn" onClick={() => onAck(reason.trim() || undefined)}>Potwierdź bez zmian</button>
        <span style={{ flex: 1 }} />
        <button className="lnk" onClick={onCollapse}>Zwiń</button>
      </div>
      {trade && pos && <div className="eff">Decyzja trafia do dziennika; transakcję zapiszesz po wykonaniu (import albo ręcznie).</div>}
    </div>
  );
}

