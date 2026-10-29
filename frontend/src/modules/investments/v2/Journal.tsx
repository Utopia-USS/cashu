// Decision journal in v2 style (ia-v2.md 10 `#/{slug}/investments/journal`: signals history + decision
// journal, a drawer in v1, a page in v2): the record grouped by month (decisions with the signal they answer,
// signals as they appeared, signals that expired without a decision), the year in numbers and the signals
// history table. Filters: Wszystko / Decyzje / Sygnały and one instrument (`?instrument=` from the asset
// detail's "dziennik" link). A decision can be undone here for 15 minutes like next to the signal (F5 R4).
import { type ReactNode, useMemo, useRef, useState } from "react";
import { useAsync } from "../../../hooks";
import { Seg, Skeleton, useToast } from "../../../ui";
import { FootFacts, Grid, PolarityText, PolDot, Widget } from "../../../widgets";
import { type AccountRow, type Decision, deleteDecision, getDecisions } from "../api";
import { DECISION_ACTION, dm, money, qty } from "../labels";
import { intlLocale } from "../../../i18n.ts";
import { S, STATUS_L } from "./Journal.strings.ts";
import { canUndo, makeUndo, type Undo, undoMessage, undoSettled } from "../undo";
import type { InstrumentChoice } from "./Alerts";
import { getSignalsV2, invKey, type SignalV2 } from "./api";
import { localDay, parseServerTime, todayLocal } from "../../../time";
import { groupByMonth, type JournalEntry, journalEntries, type JournalFilter, journalStats, polarityOf, signalText } from "./logic";

const STATUS: Record<string, string> = STATUS_L;
const PAGE = 40;

export function Journal({ slug, instruments, accounts, initialInstrument, onBack, onOpenAsset, onChanged }: {
  slug: string;
  instruments: InstrumentChoice[];
  accounts: AccountRow[];
  initialInstrument: string | null;
  onBack: () => void;
  onOpenAsset: (id: number) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  // Keyed (F7 PX4); an undo goes through onChanged (the home's reload forgets the cached investments views).
  const sig = useAsync(() => getSignalsV2(slug, "all"), [slug, nonce], { key: invKey(slug, "signals", "all") });
  const dec = useAsync(() => getDecisions(slug), [slug, nonce], { key: invKey(slug, "decisions") });
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [only, setOnly] = useState<string>(initialInstrument ?? "");
  const [shown, setShown] = useState(PAGE);
  const undos = useRef(new Map<number, Undo>());
  const today = todayLocal();
  const year = today.slice(0, 4);

  const names = useMemo(() => {
    const m = new Map<number, string>(instruments.map((i) => [i.id, i.label]));
    for (const s of sig.data ?? []) if (s.instrument_id != null && !m.has(s.instrument_id) && s.instrument_label) m.set(s.instrument_id, s.instrument_label);
    return m;
  }, [instruments, sig.data]);
  const choices = [...names].sort((a, b) => a[1].localeCompare(b[1], intlLocale()));
  const signals = sig.data ?? [];
  const decisions = dec.data ?? [];
  const entries = journalEntries(signals, decisions, filter, only || null);
  const stats = journalStats(signals, decisions, year);
  const groups = groupByMonth(entries.slice(0, shown).map((e) => ({ ...e, date: localDay(e.at) ?? e.at.slice(0, 10) })), today);
  const sigRows = signals.filter((s) => !only || String(s.instrument_id) === only).sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));

  const undo = (d: Decision) => {
    let u = undos.current.get(d.id);
    if (!u) { u = makeUndo(parseServerTime(d.created_at) || Date.now(), () => deleteDecision(slug, d.id)); undos.current.set(d.id, u); }
    void u.undo().then((res) => {
      const msg = undoMessage(res, S.decisionNoun);
      if (msg) toast(msg, res === "failed" ? 6000 : 3000);
      if (undoSettled(res)) { setNonce((n) => n + 1); onChanged(); }
    });
  };

  const instLink = (id: number | null) => (id == null ? <span className="muted">{S.portfolio}</span>
    : <button className="lnk" onClick={() => onOpenAsset(id)}>{names.get(id) ?? S.instrument(id)}</button>);
  const sigWords = (s: SignalV2) => {
    const t = signalText(s, { names });
    return [t.lead?.replace(/ ·$/, ""), t.bold, t.tail?.replace(/^· /, "")].filter(Boolean).join(" ") || t.title;
  };
  const row = (e: JournalEntry<SignalV2, Decision> & { date: string }, k: number) => {
    const s = e.signal, d = e.decision;
    let dot = "", head: string, main: ReactNode = null, tail: ReactNode = null;
    if (d) {
      dot = "nw";
      head = S.decisionHead(DECISION_ACTION[d.action] ?? d.action);
      main = <>{instLink(d.instrument_id ?? s?.instrument_id ?? null)}{d.quantity != null && (d.action === "bought" || d.action === "sold") ? ` · ${qty(d.quantity)}${d.price != null ? ` @ ${money(d.price, d.currency ?? "PLN")}` : ""}` : ""}</>;
      tail = <>{d.reason ? S.reason(d.reason) : ""}{s ? S.onSignal(signalText(s, { names }).title) : ""}
        {canUndo(d) && <> · <button className="lnk" onClick={() => undo(d)}>{S.undoLower}</button></>}</>;
    } else if (s && e.type === "signal") {
      const pol = polarityOf(s);
      dot = pol === "positive" ? "pos" : pol === "negative" ? "neg" : "";
      head = pol === "positive" ? S.opportunity : pol === "negative" ? S.risk : S.signal;
      main = <>{s.instrument_id != null ? <>{instLink(s.instrument_id)} · </> : null}{s.instrument_id != null ? sigWords(s) : signalText(s, { names }).title}</>;
      tail = s.decisions.length ? S.withDecision : s.status === "active" ? S.open : null;
    } else if (s) {
      head = e.type === "expired" ? S.expiredNoDecision : S.resolvedNoDecision;
      main = <>{s.instrument_id != null ? <>{instLink(s.instrument_id)} · </> : null}{signalText(s, { names }).title}</>;
    } else return null;
    return (
      <div key={`${e.type}:${d?.id ?? s?.id}:${k}`} style={{ display: "contents" }}>
        <div className="d">{dm(e.at)}</div>
        <div className="m"><i className={dot} aria-hidden /></div>
        <div className="t"><b>{head}</b>{main && <> · {main}</>}{tail && <span>{tail}</span>}</div>
      </div>
    );
  };

  const loading = !sig.data || !dec.data;
  const acts = Object.entries(stats.byAction).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${n} × ${DECISION_ACTION[a] ?? a}`).join(" · ");
  const accName = (id: number | null) => (id == null ? null : accounts.find((a) => a.id === id)?.name ?? null);
  const withAccount = sigRows.some((s) => accName(s.account_id));
  return (
    <>
      <nav className="crumb" aria-label={S.breadcrumb}><button onClick={onBack}>{S.investments}</button> › <span>{S.journal}</span></nav>
      <div className="pagehead">
        <h2 className="ph">{S.journal}</h2>
        <Seg quiet label={S.show} value={filter} onChange={(v) => { setFilter(v); setShown(PAGE); }} items={[[S.all, "all"], [S.decisions, "decisions"], [S.signals, "signals"]]} />
        <select value={only} onChange={(e) => { setOnly(e.target.value); setShown(PAGE); }} aria-label="Instrument">
          <option value="">{S.allInstruments}</option>
          {choices.map(([id, label]) => <option key={id} value={String(id)}>{label}</option>)}
        </select>
        <span className="spacer" />
      </div>
      {(sig.error || dec.error) && <div className="err">{S.error(String(sig.error || dec.error))}</div>}
      <Grid items={[
        {
          id: "log", span: 2, node: (
            <Widget title={S.record} count={loading ? undefined : entries.length || undefined} body="tight"
              footer={<><span className="spacer" />{entries.length > shown && <button className="lnk" onClick={() => setShown((n) => n + PAGE)}>{S.showMore(Math.min(PAGE, entries.length - shown))}</button>}</>}>
              {loading ? <Skeleton h={160} /> : !entries.length ? (
                <div className="empty">{filter === "decisions" ? S.noDecisions : S.noEntries}</div>
              ) : (
                <div className="tl wide">
                  {groups.map((g) => (
                    <div key={g.key} style={{ display: "contents" }}>
                      <div className="grp">{g.label}</div>
                      {g.items.map((e, k) => row(e, k))}
                    </div>
                  ))}
                </div>
              )}
            </Widget>
          ),
        },
        {
          id: "stats", span: 1, node: (
            <Widget title={S.inNumbers(year)} body="tight">
              {loading ? <Skeleton h={120} /> : (
                <div className="facts" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                  <div className="fact"><div className="l">{S.decisions}</div><div className="v">{stats.decisions}</div>{acts && <div className="d">{acts}</div>}</div>
                  <div className="fact"><div className="l">{S.signals}</div><div className="v">{stats.signals}</div><div className="d">{S.decidedExpired(stats.decided, stats.expired)}</div></div>
                  <div className="fact"><div className="l">{S.timeToDecision}</div><div className="v">{stats.medianDays == null ? "-" : stats.medianDays < 1 ? S.underDay : S.days(Math.round(stats.medianDays))}</div><div className="d">{S.medianFromSignal}</div></div>
                  <div className="fact"><div className="l">{S.noDecision}</div><div className="v">{stats.signals ? S.pctInt(Math.round((stats.expired / stats.signals) * 100)) : "-"}</div><div className="d">{S.signalsExpired}</div></div>
                </div>
              )}
            </Widget>
          ),
        },
        {
          id: "history", span: 3, node: (
            <Widget title={S.history} count={loading ? undefined : sigRows.length || undefined} body="flush tight">
              {loading ? <div style={{ padding: "0 16px" }}><Skeleton h={100} /></div> : !sigRows.length ? <div className="empty" style={{ padding: "0 16px 12px" }}>{S.noSignals}</div> : (
                <div className="scroll">
                  <table>
                    <thead><tr><th>{S.thSince}</th><th>{S.thSignal}</th><th>{S.thType}</th><th>{S.thStatus}</th><th>{S.thDecision}</th>{withAccount && <th>{S.thAccount}</th>}</tr></thead>
                    <tbody>
                      {sigRows.slice(0, 200).map((s) => {
                        const last = s.decisions[s.decisions.length - 1];
                        return (
                          <tr key={s.id}>
                            <td className="tnum">{dm(s.first_seen_at)}</td>
                            <td style={{ whiteSpace: "normal" }}><PolDot polarity={polarityOf(s)} /> {s.instrument_id != null ? <>{instLink(s.instrument_id)} <span className="sym">{sigWords(s)}</span></> : signalText(s, { names }).title}</td>
                            <td><PolarityText polarity={polarityOf(s)} /></td>
                            <td>{STATUS[s.status] ?? s.status}{s.closed_at ? ` ${dm(s.closed_at)}` : ""}</td>
                            <td className={last ? undefined : "muted"}>{last ? DECISION_ACTION[last.action] ?? last.action : "-"}</td>
                            {withAccount && <td className="muted">{accName(s.account_id) ?? ""}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Widget>
          ),
        },
      ]} />
    </>
  );
}
