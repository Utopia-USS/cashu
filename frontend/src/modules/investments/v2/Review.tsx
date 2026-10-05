// The weekly review as a strip (ia-v2.md 4, F-07) and re-entry after a gap (F-04): the review strip (period,
// three steps as chips, the previous review, a note, one primary button), Co się zmieniło (six facts in three
// columns), the re-entry banner (six facts, two actions), the change log grouped by month (Ważne / Wszystko)
// and Stan dziś with the since-then line vs the benchmark. Facts, not sentences.
import { type ReactNode, useState } from "react";
import { LineChart } from "../../../charts";
import { labelIndices } from "../../../chart";
import { label, proposalSummary } from "../../../core/messages";
import { Seg } from "../../../ui";
import { Facts, Widget } from "../../../widgets";
import type { AccountRow, Proposal } from "../api";
import { accountLabel, bucketLabel, DECISION_ACTION, dm, money, money0, nTxns, pct, plural, pp, txnType } from "../labels";
import { runError } from "../logic";
import type { Alert, DigestEvent, DigestV2, Performance, SignalV2 } from "./api";
import { changeSince, digestValueLine, gapText, groupByMonth, isImportant, polarityOf, signalText } from "./logic";

// ---- review strip ---------------------------------------------------------------------------------------------

export function ReviewStrip({ digest, step, onStep, decided, total, note, onNote, onDone, busy, researchRan }: {
  digest: DigestV2; step: number; onStep: (k: number) => void; decided: number; total: number;
  note: string; onNote: (v: string) => void; onDone: () => void;
  /** The review is being saved (F7 FE2). */
  busy?: boolean;
  /** A research run happened in the period: step 1 reads `Zmiany i research` (F6 research layer). */
  researchRan?: boolean;
}) {
  const last = digest.last_review;
  const minutes = last && typeof last.stats?.minutes === "number" ? last.stats.minutes : null;
  return (
    <section className="w review hl" aria-label="Przegląd tygodnia">
      <div className="title">Przegląd tygodnia <span className="muted" style={{ fontWeight: 500 }}>· {dm(digest.since)} - {dm(digest.as_of)}</span></div>
      <div className="rsteps" role="group" aria-label="Kroki przeglądu">
        <button aria-current={step === 0 ? "step" : undefined} className={step > 0 ? "done" : step === 0 ? "on" : ""} onClick={() => onStep(0)}>{step > 0 ? "✓" : "1"} {researchRan ? "Zmiany i research" : "Zmiany"}</button>
        <button aria-current={step === 1 ? "step" : undefined} className={step > 1 ? "done" : step === 1 ? "on" : ""} onClick={() => onStep(1)}>{step > 1 ? "✓" : "2"} Sygnały <b>{decided} z {total}</b></button>
        <button aria-current={step === 2 ? "step" : undefined} className={step === 2 ? "on" : ""} onClick={() => onStep(2)}>3 Zamknij</button>
      </div>
      {last && <span className="muted" style={{ fontSize: 12 }}>poprzedni: {dm(last.done_at)}{minutes ? ` · ${minutes} min` : ""}</span>}
      <span style={{ flex: 1 }} />
      <input id="inv-review-note" value={note} onChange={(e) => onNote(e.target.value)} placeholder="Notatka" aria-label="Notatka z przeglądu" />
      <button className="btn primary" onClick={onDone} disabled={busy}>Zamknij przegląd</button>
    </section>
  );
}

const KIND_PHRASE: Record<string, string> = {
  drawdown_from_high: "transza spadkowa", allocation_drift: "dryf alokacji", position_concentration: "koncentracja", contribution_gap: "brak wpłaty",
  gain_from_cost: "zysk od kosztu", loss_from_cost: "strata od kosztu", cash_level: "poziom gotówki", tagged_weight: "udział tagów",
};
const phrase = (kind?: string, message?: string) => (kind ? KIND_PHRASE[kind] ?? (kind.startsWith("alert:") ? "alert" : message || kind) : message || "");
/** Signal events of the change log: the instrument, or the bucket of an allocation-drift event (F6 BE
 * `bucket_id`; before it the log said "dryf alokacji" for every bucket). */
const subject = (e: DigestEvent, inst: string) => inst || (e.kind === "allocation_drift" && e.bucket_id ? bucketLabel(e.bucket_id) : "");

function Chg({ k, v, onKey }: { k: string; v: ReactNode; onKey?: () => void }) {
  return <div className="chg"><span className="k">{onKey ? <button onClick={onKey}>{k}</button> : k}</span><span className="v">{v}</span></div>;
}

/** Co się zmieniło: value vs benchmark over the same days, signals, alerts, transactions, dividends, strategy. */
export function ChangesWidget({ digest, perf, alerts, proposals, accounts, names, onSignals, onProposal, onJournal, research }: {
  digest: DigestV2; perf: Performance | null | undefined; alerts: Alert[]; proposals: Proposal[]; accounts: AccountRow[]; names?: Map<number, string>;
  onSignals: () => void; onProposal: (id: number) => void; onJournal: () => void;
  /** `Research` row (F6 research layer, research/ReviewBlock.tsx `researchChanges`); null = no run in the period. */
  research?: ReactNode;
}) {
  const v = digest.value;
  const c = v.currency;
  const since = changeSince(perf?.points ?? [], digest.since);
  const benchName = perf?.benchmark?.id ?? "benchmark";
  const line = digestValueLine(v, since.pct);
  const market = line.amount;
  const marketPct = line.pct;
  const sg = digest.signals;
  const events = digest.events ?? [];
  const trig = events.filter((e) => e.type === "alert_triggered");
  const agentAdded = alerts.filter((a) => a.source === "agent" && (a.created_at ?? "") >= digest.since_at).length;
  const types = Object.entries(digest.transactions.by_type).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} × ${txnType(t)}`).join(", ");
  const imports = digest.imports;
  const byAcc = [...new Set(imports.map((b) => { const a = accounts.find((x) => x.id === b.account_id); return a ? accountLabel(a, accounts) : b.account_name ?? ""; }))].filter(Boolean);
  const divs = Object.entries(digest.dividends).filter(([, x]) => x);
  const alertTitle = (e: DigestEvent) => alerts.find((a) => a.id === e.alert_id)?.title ?? e.instrument_label ?? "alert";
  const sigNames = (l: SignalV2[]) => l.map((s) => signalText(s, { names }).title.replace(/^([A-ZŁŚŻĆ])(?=[a-ząćęłńóśźż])/, (m) => m.toLowerCase())).slice(0, 3).join(", ");
  const st = digest.strategy;
  return (
    <Widget title="Co się zmieniło" count={`od ${dm(digest.since)}`} controls={<button className="lnk" onClick={onJournal}>pełny dziennik</button>} body="tight">
      <div className="changes">
        <Chg k="Wartość" v={market != null ? <>
          <b className={market >= 0 ? "pos" : "neg"}>{money(market, c, true)}</b>{marketPct != null && <b> ({pct(marketPct, true)})</b>}
          <span className="s">{line.kind === "value" ? " · z przeniesieniami" : ""}{line.contributions ? ` · bez wpłat ${money0(line.contributions, c)}` : ""}{line.kind === "market" && since.bench != null ? ` · ${benchName} ${pct(since.bench, true)}` : ""}{line.kind === "market" && since.bench != null && since.pct != null ? <> · <b>{pp((since.pct - since.bench) * 100)}</b></> : ""}</span>
        </> : <><b>{money(v.now, c)}</b> <span className="s">· brak wyceny z początku okresu</span></>} />
        {(!!v.transfers || !!v.implied_funding || line.transfersUnvalued) && <Chg k="Przeniesienia" v={<>
          {!!v.transfers && <b>{money(v.transfers, c, true)}</b>}
          {line.transfersUnvalued && <span className="s">nie do wyceny</span>}
          {!!v.implied_funding && <span className="s">{v.transfers || line.transfersUnvalued ? " · " : ""}brakujące wpłaty {money0(v.implied_funding, c)}</span>}
        </>} />}
        <Chg k="Sygnały" onKey={onSignals} v={sg.new.length || sg.resolved.length ? <>
          <b>{[sg.new.length && plural(sg.new.length, "nowy", "nowe", "nowych"), sg.resolved.length && plural(sg.resolved.length, "wygasł", "wygasły", "wygasło")].filter(Boolean).join(", ")}</b>
          {sg.new.length > 0 && <span className="s"> · nowe: {sigNames(sg.new as SignalV2[])}</span>}
        </> : <span className="s">bez nowych · {plural(sg.open, "otwarty", "otwarte", "otwartych")}</span>} />
        {research != null && <Chg k="Research" v={research} />}
        <Chg k="Alerty" v={trig.length || agentAdded ? <>
          {trig.length > 0 && <b>{plural(trig.length, "wyzwolony", "wyzwolone", "wyzwolonych")}</b>}
          <span className="s">{trig.length ? ` · ${trig.slice(0, 2).map(alertTitle).join(", ")}` : ""}{agentAdded ? ` · ${plural(agentAdded, "dodany", "dodane", "dodanych")} przez agenta` : ""}</span>
        </> : <span className="s">bez wyzwoleń</span>} />
        <Chg k="Transakcje" v={digest.transactions.count ? <>
          <b>{digest.transactions.count}</b>{byAcc.length ? ` z ${byAcc.join(", ")}` : ""}{imports[0] ? ` (${dm(imports[0].created_at)})` : ""}
          <span className="s">{types ? ` · ${types}` : ""}</span>
        </> : <span className="s">brak nowych</span>} />
        <Chg k="Dywidendy" v={divs.length ? <><b className="pos">{divs.map(([cc, x]) => money(x, cc, true)).join(" · ")}</b> <span className="s">· leży jako gotówka</span></> : <span className="s">brak</span>} />
        <Chg k="Strategia" v={<>
          {st.version == null ? "brak strategii" : st.changed_since ? <b>nowa wersja v{st.version}</b> : <>bez zmian · v{st.version}</>}
          {proposals.length > 0 && <span className="s"> · {plural(proposals.length, "propozycja", "propozycje", "propozycji")} agenta{proposalSummary(proposals[0]) ? `: ${proposalSummary(proposals[0])}` : ""} · </span>}
          {proposals.length > 0 && <button className="lnk" onClick={() => onProposal(proposals[0].id)}>zobacz</button>}
        </>} />
      </div>
    </Widget>
  );
}

// ---- re-entry ---------------------------------------------------------------------------------------------------

export function ReentryBanner({ since, days, digest, perf, alerts, proposals, depositPlan, onReview, onDismiss }: {
  since: string; days: number; digest: DigestV2 | null; perf: Performance | null | undefined; alerts: Alert[]; proposals: Proposal[];
  depositPlan: boolean; onReview: () => void; onDismiss: () => void;
}) {
  const ev = digest?.events ?? [];
  const ch = changeSince(perf?.points ?? [], since.slice(0, 10));
  const c = digest?.value.currency ?? perf?.base_currency ?? "PLN";
  const created = ev.filter((e) => e.type === "signal_created" || e.type === "alert_triggered").length;
  const expired = ev.filter((e) => e.type === "signal_resolved" && e.status === "expired").length;
  const trig = ev.filter((e) => e.type === "alert_triggered");
  const agentTrig = trig.filter((e) => alerts.find((a) => a.id === e.alert_id)?.source === "agent").length;
  const deposits = ev.filter((e) => e.type === "deposit");
  const monthsGap = Math.max(1, Math.round(days / 30.4));
  const depMonths = new Set(deposits.map((e) => e.date.slice(0, 7))).size;
  const imports = ev.filter((e) => e.type === "import").length;
  const benchName = perf?.benchmark?.id ?? "benchmark";
  return (
    <section className="w reentry" aria-label="Powrót po przerwie">
      <div>
        <div className="t">{gapText(days)} <span>ostatnio {dm(since)} · od tego czasu:</span></div>
        <div className="row">
          <div className="fact"><div className="l">Wartość</div><div className={`v ${ch.pct == null ? "" : ch.pct >= 0 ? "pos" : "neg"}`}>{ch.pct != null ? pct(ch.pct, true) : "-"}</div>
            <div className="d">{ch.money != null ? money0(ch.money, c, true) : ""}{ch.bench != null ? ` · ${benchName} ${pct(ch.bench, true)}` : ""}</div></div>
          <div className="fact"><div className="l">Sygnały</div><div className="v">{created}</div><div className="d">{expired ? `${expired} wygasły bez decyzji` : "żaden nie wygasł"}</div></div>
          <div className="fact"><div className="l">Alerty</div><div className="v">{trig.length}</div><div className="d">wyzwolone{agentTrig ? ` · ${agentTrig} od agenta` : ""}</div></div>
          {depositPlan && <div className="fact"><div className="l">Wpłaty</div><div className="v">{depMonths} z {monthsGap}</div><div className="d">{depMonths >= monthsGap ? "zgodnie z planem" : `${plural(monthsGap - depMonths, "miesiąc", "miesiące", "miesięcy")} bez wpłaty`}</div></div>}
          <div className="fact"><div className="l">Transakcje</div><div className="v">{digest?.transactions.count ?? "-"}</div><div className="d">{plural(imports, "import", "importy", "importów")}</div></div>
          <div className="fact"><div className="l">Agent</div><div className="v">{proposals.length}</div><div className="d">{proposals.length ? "propozycja czeka" : "bez propozycji"}</div></div>
        </div>
      </div>
      <div className="acts">
        <button className="btn primary" onClick={onReview}>Przejrzyj zmiany</button>
        <button className="btn ghost" onClick={onDismiss}>Wszystko jasne</button>
      </div>
    </section>
  );
}

interface LogEvent extends DigestEvent { agent?: boolean; proposalId?: number }

function eventView(e: LogEvent, accounts: AccountRow[], alerts: Alert[], names?: Map<number, string>): { dot: string; head: string; main: string; tail?: string } {
  const pol = e.polarity === "positive" ? "pos" : e.polarity === "negative" ? "neg" : "";
  const inst = (e.instrument_id != null ? names?.get(e.instrument_id) : undefined) ?? e.instrument_label ?? "";
  switch (e.type) {
    case "alert_triggered": {
      // The alert's own title, then the Polish fact of the coded message (F6 BE `message_code`), e.g. "cena 138,20 zł poniżej 140,00 zł".
      const fact = label(e.message_code, e.message_params);
      return { dot: pol, head: e.agent ? "Alert agenta wyzwolony" : "Alert wyzwolony", main: alerts.find((a) => a.id === e.alert_id)?.title ?? (typeof e.message_params?.title === "string" ? e.message_params.title : inst),
        tail: [fact, e.status === "active" || !e.status ? "sygnał otwarty" : null].filter(Boolean).join(" · ") || undefined };
    }
    case "signal_created": return { dot: pol, head: e.polarity === "positive" ? "Szansa" : e.polarity === "negative" ? "Ryzyko" : "Sygnał", main: [subject(e, inst), phrase(e.kind, e.message)].filter(Boolean).join(" · ") };
    case "signal_escalated": return { dot: pol, head: "Eskalacja", main: [subject(e, inst), phrase(e.kind, e.message)].filter(Boolean).join(" · ") };
    case "signal_resolved": return { dot: "", head: e.status === "expired" ? "Wygasł bez decyzji" : "Rozstrzygnięty", main: [subject(e, inst), phrase(e.kind, e.message)].filter(Boolean).join(" · ") };
    case "import": return { dot: "nw", head: "Import", main: nTxns(e.inserted ?? 0), tail: e.file_name };
    case "decision": return { dot: "nw", head: `Decyzja: ${DECISION_ACTION[e.action ?? ""] ?? e.action}`, main: inst, tail: e.reason ? `„${e.reason}"` : undefined };
    case "deposit":
    case "withdrawal": {
      const a = accounts.find((x) => x.id === e.account_id);
      return { dot: "nw", head: e.type === "deposit" ? "Wpłata" : "Wypłata", main: money0(Math.abs(e.amount ?? 0), e.currency), tail: a ? accountLabel(a, accounts) : undefined };
    }
    case "data_warning": return { dot: "", head: "Ostrzeżenie danych", main: runError(e.message) };
    case "proposal": return { dot: "nw", head: "Propozycja agenta", main: e.message ?? "", tail: "czeka na decyzję" };
    default: return { dot: "", head: e.type, main: e.message ?? "" };
  }
}

export function ChangeLog({ since, digest, alerts, proposals, accounts, today, names, onJournal }: {
  since: string; digest: DigestV2 | null; alerts: Alert[]; proposals: Proposal[]; accounts: AccountRow[]; today: string; names?: Map<number, string>; onJournal: () => void;
}) {
  const [filter, setFilter] = useState<"important" | "all">("important");
  const all = filter === "all";
  const events: LogEvent[] = [
    ...(digest?.events ?? []).map((e) => ({ ...e, agent: e.alert_id != null && alerts.find((a) => a.id === e.alert_id)?.source === "agent" })),
    ...proposals.filter((p) => (p.created_at ?? "") >= since).map((p) => ({ type: "proposal", at: p.created_at!, date: p.created_at!.slice(0, 10), message: proposalSummary(p) ?? p.summary ?? p.kind, proposalId: p.id })),
  ];
  const shown = all ? events : events.filter(isImportant);
  const groups = groupByMonth(shown, today);
  return (
    <Widget title={`Co się zmieniło od ${dm(since)}`} id="inv-changelog"
      controls={<Seg quiet label="Filtr zmian" value={filter} onChange={setFilter} items={[["Ważne", "important"], [`Wszystko (${events.length})`, "all"]]} />}
      body="tight"
      footer={<><span className="spacer" /><button className="lnk" onClick={onJournal}>pełny dziennik</button></>}>
      {!digest ? <div className="skeleton" style={{ height: 120 }} /> : !shown.length ? <div className="empty">Brak ważnych zmian.</div> : (
        <div className="tl">
          {groups.map((g) => (
            <div key={g.key} style={{ display: "contents" }}>
              <div className="grp">{g.label}</div>
              {g.items.map((e, k) => {
                const v = eventView(e, accounts, alerts, names);
                return (
                  <div key={`${g.key}:${k}`} style={{ display: "contents" }}>
                    <div className="d">{dm(e.date)}</div>
                    <div className="m"><i className={v.dot} aria-hidden /></div>
                    <div className="t"><b>{v.head}</b>{v.main ? ` · ${v.main}` : ""}{v.tail && <span> · {v.tail}</span>}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Widget>
  );
}

export function StateToday({ since, total, base, ytd, perf, signals, reviewText, onSignals }: {
  since: string; total: number; base: string; ytd: Performance | null | undefined; perf: Performance | null | undefined;
  signals: SignalV2[]; reviewText: string; onSignals: () => void;
}) {
  const open = signals.filter((s) => !s.snoozed);
  const chances = open.filter((s) => polarityOf(s) === "positive");
  const risks = open.filter((s) => polarityOf(s) !== "positive");
  const sigNames = (l: SignalV2[]) => [...new Set(l.map((s) => (s.payload.symbol as string) || signalText(s).title))].slice(0, 4).join(", ");
  const pts = (perf?.points ?? []).filter((p) => p.date >= since.slice(0, 10));
  const base0 = pts[0];
  const rel = (x: number | null, x0: number | null) => (x == null || x0 == null ? null : (1 + x) / (1 + x0) - 1);
  const pv = pts.map((p) => rel(p.twr, base0?.twr ?? null));
  const bv = pts.map((p) => rel(p.benchmark, base0?.benchmark ?? null));
  const lastP = pv[pv.length - 1], lastB = bv[bv.length - 1];
  const dd = perf?.points.length ? perf.points[perf.points.length - 1].drawdown : null;
  const md = perf?.summary?.max_drawdown;
  const ys = ytd?.summary?.twr, yb = ytd?.benchmark?.twr;
  return (
    <Widget title="Stan dziś" controls={perf?.as_of ? <span className="tag">{dm(perf.as_of)}</span> : undefined} body="tight"
      footer={<><span>przegląd tygodnia: <b>{reviewText}</b></span><span className="spacer" /><button className="lnk" onClick={onSignals}>do sygnałów</button></>}>
      <Facts items={[
        { label: "Wartość", value: money0(total, base), detail: ys != null ? <><span className={ys >= 0 ? "pos" : "neg"}>{pct(ys, true)}</span> YTD{yb != null ? ` · ${ytd?.benchmark?.id ?? "benchmark"} ${pct(yb, true)}` : ""}</> : undefined },
        { label: "Od szczytu", value: pct(dd), detail: md?.peak ? `szczyt ${dm(md.peak)}` : undefined },
        { label: "Szanse", value: chances.length, detail: sigNames(chances) || undefined },
        { label: "Ryzyka", value: risks.length, detail: sigNames(risks) || undefined },
      ]} />
      {pts.length > 2 && (
        <>
          <div style={{ marginTop: 12 }}>
            <LineChart label={`Portfel od ${dm(since)} i benchmark`} height={120} padL={34} padR={58} yTicks={2} yFmt={(v) => `${Math.round(v * 100)} %`}
              xLabels={labelIndices(pts.length, 3).map((i) => ({ i, text: dm(pts[i].date) }))}
              series={[
                { values: bv, cls: "bench", endLabel: lastB != null ? pct(lastB, true) : undefined },
                { values: pv, cls: "main", area: true, endLabel: lastP != null ? pct(lastP, true) : undefined },
              ]} />
          </div>
          <div className="legend" style={{ marginTop: 4 }}><span><i className="main" />portfel od {dm(since)}</span><span><i className="bench" />{perf?.benchmark?.id ?? "benchmark"}</span></div>
        </>
      )}
    </Widget>
  );
}
