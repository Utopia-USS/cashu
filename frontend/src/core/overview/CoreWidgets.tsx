// Przegląd v2 widgets owned by core: the budget month and subscriptions (they read the budget module's
// endpoints; the budget folder belongs to that module's track, the overview composition to core), the bank
// accounts list with the cash wallet, and the card of a module that is not set up yet.
import { useState } from "react";
import { CashCard } from "../../components/CashCard";
import { cur, cur0s, MONTH_NOM, nModules, pctSigned, plural } from "../../format";
import { useAsync } from "../../hooks";
import { type CashflowRow, getCashflow, getMonthClose, getRecurring, type MonthClose } from "../../modules/budget/api";
import { todayLocal } from "../../time";
import { closedMonthNorm } from "../util";
import { Drawer, Skeleton } from "../../ui";
import { FootFacts, Widget } from "../../widgets";
import type { Account, Category, ProfileModule } from "../api";
import { getSetup } from "../api";
import { useShell } from "../context";
import { stepsTag } from "../SetupPage";
import type { ModuleCtx, ModuleDef } from "../types";

/** "2026-10-05" -> "2026-09" (the last closed month). */
export function previousMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/** Local calendar date (the UTC date is yesterday between 00:00 and 02:00 in Poland, F7 FE11). */
const todayIso = () => todayLocal();

function useMonthClose(slug: string) {
  return useAsync<MonthClose | null>(() => getMonthClose(slug, previousMonth(todayIso())).catch(() => null), [slug]);
}

// The cashflow of the last 7 months, shared by the hero, Subskrypcje and Kredyty on one page (one request).
const flowsCache = new Map<string, { at: number; p: Promise<CashflowRow[]> }>();
function cashflow7(slug: string, currency: string): Promise<CashflowRow[]> {
  const key = `${slug}:${currency}`;
  const hit = flowsCache.get(key);
  if (hit && Date.now() - hit.at < 4000) return hit.p;
  const p = getCashflow(slug, 7, currency).catch(() => [] as CashflowRow[]);
  flowsCache.set(key, { at: Date.now(), p });
  return p;
}

/** Monthly income / spending of complete months (average of up to 6 before this one) in `currency`; the
 * Przegląd ratios divide by it, never by the running month (F7 FE10). */
export function useMonthNorm(slug: string, currency: string) {
  const q = useAsync(() => cashflow7(slug, currency), [slug, currency]);
  return closedMonthNorm(q.data, todayIso());
}

/** Tooltip of a ratio over the norm. */
export const normTitle = (n: { months: number }) => `średnia z ${plural(n.months, "zamkniętego miesiąca", "zamkniętych miesięcy", "zamkniętych miesięcy")}`;

/** Budżet · <month>: income / spending / surplus bars, savings rate, 6-month average. */
export function BudgetMonthWidget({ ctx }: { ctx: ModuleCtx }) {
  const mc = useMonthClose(ctx.slug);
  const flows = useAsync(() => getCashflow(ctx.slug, 7).catch(() => []), [ctx.slug]);
  const base = ctx.profile.base_currency;
  const close = mc.data?.currencies.find((c) => c.currency === base) ?? mc.data?.currencies[0] ?? null;
  const fallback = ctx.summary.month;
  const income = close?.income ?? fallback?.income ?? null;
  const spending = close?.spending ?? fallback?.expense ?? null;
  const surplus = close?.surplus ?? fallback?.net ?? null;
  const currency = close?.currency ?? base;
  const monthKey = mc.data?.month ?? fallback?.label ?? null;
  const monthName = monthKey ? MONTH_NOM[Number(monthKey.slice(5, 7)) - 1] : "";
  const rate = income && surplus != null ? surplus / income : null;
  const closed = (flows.data ?? []).filter((r) => r.label < todayIso().slice(0, 7)).slice(-6);
  const avg = closed.length >= 2 ? closed.reduce((a, r) => a + (r.income ? r.net / r.income : 0), 0) / closed.length : null;
  const others = (mc.data?.currencies ?? []).filter((c) => c.currency !== currency).map((c) => c.currency);
  const w = (v: number | null) => `${income && v != null ? Math.max(0, Math.min(100, (Math.abs(v) / income) * 100)) : 0}%`;
  return (
    <Widget title={`Budżet${monthName ? ` · ${monthName}` : ""}`}
      tags={mc.data ? <span className={`tag solid ${mc.data.complete ? "pos" : "muted"}`}>{mc.data.complete ? "zamknięty" : "w toku"}</span> : undefined}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "budget.expenses" })}>Wydatki</button>}
      body="tight"
      footer={
        <>
          <FootFacts items={[
            rate != null && <>stopa oszczędności <b>{Math.round(rate * 100)} %</b></>,
            avg != null && <>średnia 6 mies. <b>{Math.round(avg * 100)} %</b></>,
          ]} />
          <span className="spacer" />
          {others.length > 0 && <span>inne waluty: {others.join(", ")}</span>}
        </>
      }>
      {income == null ? (mc.loading ? <Skeleton h={60} /> : <div className="empty">Brak transakcji z ostatniego miesiąca.</div>) : (
        <div className="bud">
          <span className="k">Przychody</span><span className="b"><i className="nw" style={{ width: "100%" }} /></span><span className="v">{cur0s(income, currency)}</span>
          <span className="k">Wydatki</span><span className="b"><i style={{ width: w(spending) }} /></span><span className="v">{cur0s(spending, currency)}</span>
          <span className="k">Nadwyżka</span><span className="b"><i className={(surplus ?? 0) >= 0 ? "pos" : "neg"} style={{ width: w(surplus) }} /></span>
          <span className={`v ${(surplus ?? 0) >= 0 ? "pos" : "neg"}`}>{cur0s(surplus, currency)}</span>
        </div>
      )}
    </Widget>
  );
}

/** Subskrypcje: monthly total, charges due this week, ones to check (no charge lately). */
export function SubscriptionsWidget({ ctx }: { ctx: ModuleCtx }) {
  const rec = useAsync(() => getRecurring(ctx.slug).catch(() => ({ items: [] })), [ctx.slug]);
  const subs = ctx.summary.subscriptions;
  const base = ctx.profile.base_currency;
  const monthly = subs.monthly_totals[base] ?? Object.values(subs.monthly_totals)[0] ?? null;
  const monthlyCur = subs.monthly_totals[base] != null ? base : Object.keys(subs.monthly_totals)[0] ?? base;
  const norm = useMonthNorm(ctx.slug, monthlyCur);
  const share = monthly != null && norm?.expense ? monthly / norm.expense : null;
  const items = rec.data?.items ?? [];
  const now = Date.now();
  const soon = items.filter((i) => {
    if (!i.active) return false;
    const next = new Date(`${i.last}T12:00:00`).getTime() + i.gap_days * 86400000;
    return next >= now - 86400000 && next <= now + 7 * 86400000;
  });
  const stale = items.filter((i) => !i.active);
  return (
    <Widget title="Subskrypcje" count={subs.count || undefined}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "budget.subs" })}>Subskrypcje</button>}
      body="tight"
      footer={stale.length ? <span className="warn">{plural(stale.length, "subskrypcja", "subskrypcje", "subskrypcji")} bez obciążenia</span> : undefined}>
      <div className="facts" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="fact"><div className="l">Miesięcznie</div><div className="v">{monthly != null ? cur0s(monthly, monthlyCur) : "-"}</div>
          {share != null && norm && <div className="d" title={normTitle(norm)}>{pctSigned(share, false)} wydatków</div>}</div>
        <div className="fact"><div className="l">W tym tygodniu</div><div className="v">{rec.data ? soon.length : "-"}</div>
          {soon.length > 0 && <div className="d">{soon.slice(0, 3).map((i) => i.payee).join(", ")}</div>}</div>
      </div>
    </Widget>
  );
}

const BANK: Record<string, string> = { mbank: "mBank", erste: "Erste", pekao: "Pekao", santander: "Erste", manual: "ręczne" };
const LISTED = new Set(["checking", "savings", "credit", "investment", "other"]);
const isEmptyBal = (a: Account) => a.balance == null || Math.abs(a.balance) < 0.005;

/** Konta: bank accounts (assets and loans have their own widgets), the cash wallet in the footer. */
export function AccountsWidget({ accounts, categories, onChanged }: { accounts: Account[]; categories: Category[]; onChanged: () => void }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const [cash, setCash] = useState(false);
  const list = accounts.filter((a) => LISTED.has(a.type) && !(a.bank === "manual" && a.type === "other"))
    .sort((a, b) => Math.abs(b.balance ?? 0) - Math.abs(a.balance ?? 0));
  const empties = list.filter(isEmptyBal);
  const visible = showEmpty ? list : list.filter((a) => !isEmptyBal(a));
  const wallet = accounts.find((a) => a.type === "cash");
  return (
    <Widget title="Konta" count={list.length || undefined}
      controls={empties.length > 0 ? <button className="lnk" onClick={() => setShowEmpty((v) => !v)}>{showEmpty ? "ukryj puste" : `pokaż puste (${empties.length})`}</button> : undefined}
      body="flush tight"
      footer={
        <>
          {wallet && <span>gotówka w portfelu <b>{cur(wallet.balance, wallet.currency)}</b></span>}
          <span className="spacer" />
          <button className="lnk" onClick={() => setCash(true)}>{wallet ? "+ wydatek gotówkowy" : "gotówka"}</button>
        </>
      }>
      {!list.length ? <div className="empty">Brak kont bankowych.</div> : (
        <table>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id}>
                <td>{a.name} <span className="sym inl">{[BANK[a.bank] ?? a.bank, a.iban_tail].filter(Boolean).join(" · ")}</span></td>
                <td className={`num ${(a.balance ?? 0) < 0 ? "neg" : ""} ${isEmptyBal(a) ? "muted" : ""}`}>{cur(a.balance, a.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Drawer open={cash} title="Gotówka w portfelu" onClose={() => setCash(false)} width={560}>
        <CashCard categories={categories} onChanged={onChanged} />
      </Drawer>
    </Widget>
  );
}

/** Dashed widget of an enabled module that is not (fully) set up: progress and the next step. */
export function PendingWidget({ def, m, onHide }: { def: ModuleDef; m: ProfileModule; onHide: () => void }) {
  const { slug, go } = useShell();
  const { data } = useAsync(() => getSetup(slug, def.id), [slug, def.id, m.setup_state]);
  const next = data?.steps.find((s) => s.status === "on") ?? data?.steps.find((s) => s.status !== "done");
  return (
    <Widget title={def.name} ghost tags={stepsTag(data, m.setup_state)}
      controls={<button className="lnk" onClick={onHide}>ukryj</button>}
      footer={<><span>{data ? `${data.steps.filter((s) => s.status === "done").length} z ${data.steps.length} kroków` : ""}</span><span className="spacer" />
        <button className="btn sm primary" onClick={() => go({ kind: "setup", module: def.id })}>Kontynuuj</button></>}>
      <div className="muted" style={{ fontSize: 13 }}>
        {!data ? <Skeleton w="80%" h={12} /> : next ? `Następny krok: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.` : "Moduł czeka na dane."}
      </div>
    </Widget>
  );
}

export { nModules };
