// Investments on Przegląd v2: the hero fact (value, week, chances / risks), the Inwestycje widget (YTD vs
// benchmark, polarity counts, 12-month line), the surplus -> contribution card (budget month close +
// the contribution plan + the bucket it helps) and the minimal view of a zero-start profile (hero, Wpłaty,
// Na ten miesiąc; ia-v2.md 9). The planned deposit is kept per profile and month in this browser until the
// backend stores planned deposits (NEEDS in F5-UI2.md).
import { useState } from "react";
import { LineChart, Bars } from "../../../charts";
import { useShell } from "../../../core/context";
import type { ModuleCtx } from "../../../core/types";
import { MONTH_NOM } from "../../../format";
import { useAsync } from "../../../hooks";
import { getMonthClose, type MonthClose } from "../../budget/api";
import { Skeleton, useToast } from "../../../ui";
import { Fact, FootFacts, Grid, Widget } from "../../../widgets";
import { getStrategy } from "../api";
import { accountLabel, bucketLabel, dm, money, money0, nInstruments, parseNum, pct, plural, pp } from "../labels";
import { nextDeposit } from "../logic";
import { getOverviewV2, getPerformance, getPositionsV2, getSignalsV2, type Performance } from "./api";
import { changeSince, monthlyFlows, polarityOf } from "./logic";

const MONTH_ADJ = ["styczniowa", "lutowa", "marcowa", "kwietniowa", "majowa", "czerwcowa", "lipcowa", "sierpniowa", "wrześniowa", "październikowa", "listopadowa", "grudniowa"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const todayIso = () => new Date().toISOString().slice(0, 10);
const prevMonth = (today: string) => {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const minusDays = (iso: string, days: number) => new Date(new Date(`${iso}T12:00:00`).getTime() - days * 86400000).toISOString().slice(0, 10);

// ---- planned deposit (this browser, per profile and month) -----------------------------------------------
interface Planned { amount: number; date: string; at: string }
const planKey = (slug: string, month: string) => `finanse.inv.plannedDeposit.${slug}.${month}`;
export function readPlan(slug: string, month: string): Planned | null {
  try { const raw = localStorage.getItem(planKey(slug, month)); return raw ? (JSON.parse(raw) as Planned) : null; } catch { return null; }
}
function writePlan(slug: string, month: string, p: Planned | null) {
  try { if (p) localStorage.setItem(planKey(slug, month), JSON.stringify(p)); else localStorage.removeItem(planKey(slug, month)); } catch { /* private mode */ }
}

/** Hero fact on Przegląd: the portfolio value, the week's change and chances / risks. */
export function InvestmentsHeroFact({ ctx }: { ctx: ModuleCtx }) {
  const ov = useAsync(() => getOverviewV2(ctx.slug).catch(() => null), [ctx.slug]);
  const perf = useAsync(() => getPerformance(ctx.slug, "1m").catch(() => null), [ctx.slug]);
  const k = ov.data?.kpis;
  if (!k) return <Fact label="Inwestycje" value={<Skeleton w={90} h={16} />} />;
  const c = ov.data!.base_currency;
  const week = perf.data ? changeSince(perf.data.points, minusDays(perf.data.as_of, 7)).pct : null;
  const pol = k.polarity;
  return (
    <Fact label="Inwestycje" value={money0(k.value.total, c)}
      detail={<>{week != null && <><span className={week >= 0 ? "pos" : "neg"}>{pct(week, true)}</span> tydz. · </>}
        {pol ? `${plural(pol.positive, "szansa", "szanse", "szans")} · ${plural(pol.negative + pol.neutral, "ryzyko", "ryzyka", "ryzyk")}` : `${k.signals.action + k.signals.info} sygnałów`}</>} />
  );
}

/** Inwestycje widget on Przegląd: YTD vs benchmark, chances, risks, the 12-month value line. */
export function InvestmentsSummaryWidget({ ctx }: { ctx: ModuleCtx }) {
  const ov = useAsync(() => getOverviewV2(ctx.slug).catch(() => null), [ctx.slug]);
  const ytd = useAsync(() => getPerformance(ctx.slug, "ytd").catch(() => null), [ctx.slug]);
  const year = useAsync(() => getPerformance(ctx.slug, "1y").catch(() => null), [ctx.slug]);
  const sig = useAsync(() => getSignalsV2(ctx.slug, "open").catch(() => []), [ctx.slug]);
  const open = (sig.data ?? []).filter((s) => !s.snoozed);
  const chances = open.filter((s) => polarityOf(s) === "positive");
  const risks = open.filter((s) => polarityOf(s) !== "positive");
  const names = (l: typeof open) => [...new Set(l.map((s) => String((s.payload.symbol as string) || s.instrument_label || bucketLabel(s.payload.bucket_id as string) || "")).filter(Boolean))].slice(0, 3).join(", ");
  const s = ytd.data?.summary, b = ytd.data?.benchmark;
  const triggered = ov.data?.kpis.alerts?.triggered ?? 0;
  const last = ov.data?.kpis.last_run;
  const vals = (year.data?.points ?? []).map((p) => p.value);
  const go = () => ctx.go({ kind: "tab", tab: "investments.portfolio" });
  return (
    <Widget title="Inwestycje" count={vals.length ? "12 mies." : undefined} controls={<button className="lnk" onClick={go}>Inwestycje</button>} body="tight"
      footer={<><span>{last ? <>reguły {last.status === "ok" ? "ok" : last.status === "partial" ? "częściowo" : "błąd"} · <b>{dm(last.finished_at ?? last.started_at)}</b></> : "reguły jeszcze nie działały"}</span></>}>
      <div className="facts" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <Fact label="YTD" value={s?.twr != null ? pct(s.twr, true) : "-"} tone={s?.twr != null ? (s.twr >= 0 ? "pos" : "neg") : undefined}
          detail={b?.status === "ok" && b.twr != null ? `${b.id ?? "benchmark"} ${pct(b.twr, true)}` : "bez benchmarku"} />
        <Fact label="Szanse" value={sig.data ? chances.length : "-"} detail={names(chances) || undefined} />
        <Fact label="Ryzyka" value={sig.data ? risks.length : "-"} detail={triggered ? plural(triggered, "alert wyzwolony", "alerty wyzwolone", "alertów wyzwolonych") : names(risks) || undefined} />
      </div>
      {vals.length > 2 && (
        <div style={{ marginTop: 8 }}>
          <LineChart label="Wartość portfela, 12 miesięcy" height={96} yFmt={false} padR={8} yTicks={2} series={[{ values: vals, cls: "main", area: true }]} />
        </div>
      )}
    </Widget>
  );
}

/** Nadwyżka -> wpłata: last month's surplus, the planned contribution, what stays; the checks that gate it
 * and one primary action that records the plan. Highlighted (`.hl`): the step the month asks for. */
export function SurplusWidget({ ctx }: { ctx: ModuleCtx }) {
  const toast = useToast();
  const month = prevMonth(todayIso());
  const mc = useAsync<MonthClose | null>(() => getMonthClose(ctx.slug, month).catch(() => null), [ctx.slug]);
  const ov = useAsync(() => getOverviewV2(ctx.slug).catch(() => null), [ctx.slug]);
  const ytd = useAsync(() => getPerformance(ctx.slug, "ytd").catch(() => null), [ctx.slug]);
  const curMonth = todayIso().slice(0, 7);
  const [plan, setPlanState] = useState<Planned | null>(() => readPlan(ctx.slug, curMonth));
  const [other, setOther] = useState<string | null>(null);
  const d = mc.data;
  const base = ctx.profile.base_currency;
  const close = d?.currencies.find((c) => c.currency === base) ?? d?.currencies[0] ?? null;
  const planned = d?.investing?.planned ?? null;
  const c = close?.currency ?? base;
  if (!d || !close) {
    return (
      <Widget title="Nadwyżka → wpłata" body="tight">
        {mc.loading ? <Skeleton h={70} /> : <div className="muted" style={{ fontSize: 13 }}>Zamknięcie miesiąca pojawi się, gdy budżet będzie miał transakcje z poprzedniego miesiąca.</div>}
      </Widget>
    );
  }
  const amount = planned && planned.currency === c ? planned.amount : null;
  const want = plan?.amount ?? amount;
  const stays = want != null ? close.surplus - want : null;
  const day = planned?.day_of_month ?? null;
  const due = nextDeposit(todayIso(), day);
  const cushion = d.cushion;
  const alloc = ov.data?.allocation;
  const under = alloc?.buckets.filter((b) => b.drift_pp < 0).sort((a, b) => a.drift_pp - b.drift_pp)[0];
  const closes = under && want && alloc?.total ? Math.min(Math.abs(under.drift_pp), (want / (alloc.total + want)) * 100) : null;
  const monthIdx = Number(month.slice(5, 7)) - 1;
  const deposits = ytd.data?.summary?.deposits ?? null;
  const ytdPlan = amount != null ? amount * Number(curMonth.slice(5, 7)) : null;
  const save = (value: number) => {
    const p = { amount: value, date: due, at: new Date().toISOString() };
    writePlan(ctx.slug, curMonth, p);
    setPlanState(p);
    setOther(null);
    toast(`Zaplanowano wpłatę ${money0(value, c)} · ${dm(due)}`, 6000, { label: "Cofnij", onClick: () => { writePlan(ctx.slug, curMonth, null); setPlanState(null); } });
  };
  const otherNum = other != null ? parseNum(other) : null;
  return (
    <Widget title="Nadwyżka → wpłata" hl={!plan} tags={<span className="tag">{dm(due)}</span>}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "budget.flows" })}>zamknięcie miesiąca</button>}
      body="tight"
      footer={<>
        <FootFacts items={[deposits != null && ytdPlan != null && <>wpłaty {curMonth.slice(0, 4)}: <b>{money0(deposits, c)}</b> z {money0(ytdPlan, c)}</>]} />
        <span className="spacer" /><span>{plan ? "plan zapisany w tej przeglądarce" : "import wpłaty potwierdzi plan"}</span>
      </>}>
      <div className="flow">
        <Fact label={`Nadwyżka ${ROMAN[monthIdx]}`} value={money0(close.surplus, c)} tone={close.surplus < 0 ? "neg" : undefined} />
        <span className="arrow" aria-hidden>→</span>
        <Fact label="Plan wpłaty" value={want != null ? money0(want, c) : "-"} detail={want == null ? "brak planu w strategii" : day ? `do ${day}. dnia` : undefined} />
        <span className="arrow" aria-hidden>→</span>
        <Fact label={stays != null && stays < 0 ? "Brakuje" : "Zostaje"} value={stays != null ? money0(Math.abs(stays), c) : "-"} tone={stays != null && stays < 0 ? "warn" : undefined}
          detail={stays != null && stays >= 0 ? (cushion?.accounts[0] ? `na ${cushion.accounts[0].name.toLowerCase()}` : "na koncie") : undefined} />
      </div>
      <div className="checks">
        {cushion?.enabled && (cushion.reached
          ? <><span className="ok">✓</span> poduszka {cushion.target_months ? `${cushion.target_months} mies.` : money0(cushion.target, cushion.currency)}</>
          : <><span className="no">!</span> poduszka: brakuje {money0(cushion.missing, cushion.currency)}</>)}
        {cushion?.enabled && under && closes != null ? " · " : ""}
        {under && closes != null && <>{bucketLabel(under.bucket_id)} poniżej celu: wpłata domyka {pp(closes).replace(/^\+/, "")}</>}
        {!cushion?.enabled && !(under && closes != null) && <>sprawdzane: poduszka finansowa (ustaw w Przepływach) i koszyk poniżej celu</>}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {plan ? (
          <span className="tag solid pos">zaplanowano {money0(plan.amount, c)} · {dm(plan.date)}</span>
        ) : other == null ? (
          <>
            {want != null && <button className="btn primary" onClick={() => save(want)}>Zaplanuj wpłatę {money0(want, c)}</button>}
            <button className="btn" onClick={() => setOther(want != null ? String(Math.round(want)) : "")}>Inna kwota</button>
          </>
        ) : (
          <>
            <input className="num" inputMode="decimal" aria-label="Kwota wpłaty" value={other} onChange={(e) => setOther(e.target.value)} style={{ width: 110 }} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && otherNum && otherNum > 0) save(otherNum); if (e.key === "Escape") setOther(null); }} />
            <button className="btn primary" disabled={!otherNum || otherNum <= 0} onClick={() => otherNum && save(otherNum)}>Zaplanuj</button>
            <button className="lnk" onClick={() => setOther(null)}>Anuluj</button>
          </>
        )}
        {plan && <button className="lnk" onClick={() => { writePlan(ctx.slug, curMonth, null); setPlanState(null); }}>zmień</button>}
      </div>
    </Widget>
  );
}

// ---- minimal profile (zero start) --------------------------------------------------------------------------

/** Deposits view of a light profile: months with a deposit since the first one, the last deposit, the plan. */
export function depositFacts(perf: Performance | null, today: string) {
  const flows = (perf?.points ?? []).filter((p) => (p.flow ?? 0) > 0).map((p) => ({ date: p.date, amount: p.flow! }));
  const first = flows[0]?.date ?? null;
  // Months from the first deposit; the current month counts only once its deposit is in.
  const thisMonth = flows.some((f) => f.date.slice(0, 7) === today.slice(0, 7));
  const monthsSince = first ? (Number(today.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(first.slice(5, 7)) + (thisMonth ? 1 : 0) : 0;
  const withDeposit = new Set(flows.map((f) => f.date.slice(0, 7))).size;
  const amounts = [...new Set(flows.map((f) => f.amount))];
  return { flows, first, monthsSince, withDeposit, same: amounts.length === 1 ? amounts[0] : null, last: flows[flows.length - 1] ?? null };
}

export function MinimalOverview({ ctx }: { ctx: ModuleCtx }) {
  const { go } = useShell();
  const toast = useToast();
  const slug = ctx.slug;
  const ov = useAsync(() => getOverviewV2(slug).catch(() => null), [slug]);
  const pos = useAsync(() => getPositionsV2(slug).catch(() => null), [slug]);
  const perf = useAsync(() => getPerformance(slug, "max").catch(() => null), [slug]);
  const strat = useAsync(() => getStrategy(slug).catch(() => null), [slug]);
  const today = todayIso();
  const curMonth = today.slice(0, 7);
  const [plan, setPlanState] = useState<Planned | null>(() => readPlan(slug, curMonth));
  const k = ov.data?.kpis;
  const c = ov.data?.base_currency ?? ctx.profile.base_currency;
  const s = perf.data?.summary;
  const dep = depositFacts(perf.data, today);
  const contrib = strat.data?.facts?.contributions ?? null;
  const planAmount = contrib?.monthly_amount ?? dep.same ?? dep.last?.amount ?? null;
  const day = contrib?.day_of_month ?? (dep.last ? Number(dep.last.date.slice(8, 10)) : null);
  const due = nextDeposit(today, day);
  const accounts = ov.data?.accounts ?? [];
  const acc = accounts.length === 1 ? accountLabel(accounts[0], accounts) : null;
  const holdings = pos.data?.positions ?? [];
  const months = monthlyFlows(perf.data?.points ?? [], today, 6);
  const doneThisMonth = dep.flows.some((f) => f.date.slice(0, 7) === curMonth);
  const lastPrev = [...dep.flows].reverse().find((f) => f.date.slice(0, 7) < curMonth) ?? null;
  const pol = k?.polarity;
  const alertsLive = k?.alerts ? k.alerts.active + k.alerts.triggered + k.alerts.snoozed : 0;
  const quiet = [alertsLive ? plural(alertsLive, "alert", "alerty", "alertów") : "bez alertów", pol && pol.positive + pol.negative + pol.neutral ? plural(pol.positive + pol.negative + pol.neutral, "sygnał", "sygnały", "sygnałów") : "bez sygnałów"].join(" · ");
  const savePlan = () => {
    if (planAmount == null) return;
    const p = { amount: planAmount, date: due, at: new Date().toISOString() };
    writePlan(slug, curMonth, p);
    setPlanState(p);
    toast(`Zaplanowano wpłatę ${money0(planAmount, c)} · ${dm(due)}`, 6000, { label: "Cofnij", onClick: () => { writePlan(slug, curMonth, null); setPlanState(null); } });
  };
  const toInv = (sub?: string) => go({ kind: "tab", tab: "investments.portfolio", sub });
  const historyMonths = dep.monthsSince;
  return (
    <Grid items={[
      {
        id: "hero", span: 3, node: (
          <section className="w hero" aria-label="Portfel">
            <div className="h1">
              <div className="l">Portfel · {MONTH_NOM[Number(today.slice(5, 7)) - 1]}</div>
              <div className="v">{k ? money(k.value.total, c) : <Skeleton w={160} h={28} />}</div>
              {s?.pnl != null && s.net_contributions ? (
                <div className="d"><span className={s.pnl >= 0 ? "pos" : "neg"}>{money(s.pnl, c, true)} ({pct(s.pnl / s.net_contributions, true)})</span> od pierwszej wpłaty</div>
              ) : null}
            </div>
            <div className="hf">
              <Fact label="Wpłacono" value={s?.net_contributions != null ? money0(s.net_contributions, c) : "-"}
                detail={dep.flows.length ? (dep.same ? `${plural(dep.flows.length, "wpłata", "wpłaty", "wpłat")} po ${money0(dep.same, c)}` : plural(dep.flows.length, "wpłata", "wpłaty", "wpłat")) : undefined} />
              <Fact label="Benchmark" value={perf.data?.benchmark?.status === "ok" && perf.data.benchmark.twr != null ? pct(perf.data.benchmark.twr, true) : "-"}
                detail={perf.data?.benchmark?.status === "ok" ? `${perf.data.benchmark.id ?? "benchmark"}, te same wpłaty` : "ustaw w strategii"} />
              <Fact label="Następna wpłata" value={dm(due)} detail={[planAmount != null ? money0(planAmount, c) : null, acc].filter(Boolean).join(" · ") || undefined} />
            </div>
            <div className="hr">
              {holdings.length > 0 && <span className="tag">{nInstruments(holdings.length)}{holdings.length === 1 ? ` · ${holdings[0].instrument.symbol ?? holdings[0].instrument.label}` : ""}</span>}
              <div className="meta">{quiet}</div>
            </div>
          </section>
        ),
      },
      {
        id: "deposits", span: 2, node: (
          <Widget title="Wpłaty" count="6 mies." controls={planAmount != null ? <span className="muted" style={{ fontSize: 12 }}>plan: {money0(planAmount, c)}{day ? ` do ${day}. każdego miesiąca` : " co miesiąc"}</span> : undefined}
            body="tight"
            footer={<>
              <FootFacts items={[dep.monthsSince > 0 && <>regularność <b>{dep.withDeposit} z {dep.monthsSince}</b></>]} />
              <span className="spacer" />
              {historyMonths < 6 && <span>wykres wartości pojawi się po 6 miesiącach</span>}
            </>}>
            {perf.data ? (
              <Bars label="Wpłaty w ostatnich 6 miesiącach" height={150} values={months.map((m) => m.value)} labels={months.map((m) => m.label)}
                cls={months.map((m, i) => (i === months.length - 1 && !m.value && planAmount ? "plan" : "main"))}
                valueLabels={months.map((m) => (m.value ? money0(m.value, c) : null))} plan={planAmount} planLabel={planAmount != null ? `plan ${money0(planAmount, c)}` : undefined} />
            ) : <Skeleton h={150} />}
          </Widget>
        ),
      },
      {
        id: "month", span: 1, node: (
          <Widget title="Na ten miesiąc" body="tight"
            footer={<span>chcesz więcej? <button className="lnk" onClick={() => toInv("alerts?new=1")}>dodaj alert</button> · <button className="lnk" onClick={() => toInv("watch")}>obserwuj instrument</button></span>}>
            <div className="steps-v">
              {lastPrev && (
                <div className="step done"><b className="n" aria-label="zrobione">✓</b><div>Wpłata {MONTH_ADJ[Number(lastPrev.date.slice(5, 7)) - 1]}<div className="h">{money0(lastPrev.amount, c)} · {dm(lastPrev.date)}</div></div><span /></div>
              )}
              <div className={`step ${doneThisMonth || plan ? "done" : "on"}`}>
                <b className="n" aria-label={doneThisMonth ? "zrobione" : "krok 2"}>{doneThisMonth || plan ? "✓" : 2}</b>
                <div>Wpłata {planAmount != null ? money0(planAmount, c) : ""} do {dm(due)}<div className="h">{doneThisMonth ? "zrobiona w tym miesiącu" : plan ? `zaplanowana ${dm(plan.date)}` : acc ?? "wg planu"}</div></div>
                {!doneThisMonth && !plan && planAmount != null ? <button className="btn sm" onClick={savePlan}>Zaplanuj</button> : <span />}
              </div>
              <div className="step"><b className="n" aria-hidden>3</b><div className="muted">Nic więcej<div className="h">przegląd raz w miesiącu wystarczy</div></div><span /></div>
            </div>
          </Widget>
        ),
      },
    ]} />
  );
}
