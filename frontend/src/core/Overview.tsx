// Przegląd v2 (design/v2/overview.html, ia-v2.md sections 2, 5, 9): the hero strip (net worth and the
// facts that matter), then the widget grid on thirds: budget month, surplus -> contribution, investments,
// net worth over time, loans and assets, accounts, subscriptions. Modules contribute widgets through
// ModuleDef.overview / HeroFact; a profile with only the investments module gets that module's minimal view
// in the narrow frame. Every currency other than the base one keeps its own total (never converted).
import { type ReactNode, useEffect, useState } from "react";
import { cur, cur0s, MONTH_GEN, nAccounts, nModules, pctSigned, TYPE_LABEL } from "../format";
import { useAsync } from "../hooks";
import { ck } from "../swr";
import { Empty } from "../ui";
import { Fact, Grid, type GridItem, Widget } from "../widgets";
import { getSeries, type ProfileModule } from "./api";
import { useShell } from "./context";
import { AccountsWidget, BudgetMonthWidget, normTitle, PendingWidget, SubscriptionsWidget, useMonthNorm } from "./overview/CoreWidgets";
import { NetWorthWidget } from "./overview/NetWorthWidget";
import { moduleDef } from "./registry";
import type { ModuleCtx, ModuleDef } from "./types";

const HIDDEN_KEY = "finanse.hiddenCards";
const readHidden = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || "{}"); } catch { return {}; }
};
const LIQUID = new Set(["checking", "savings", "cash"]);
/** Whole units for hero facts, rounded (582 986,99 -> "582 987 zł"; no "-0", F7 FE11). */
const whole = (v: number, c: string) => cur0s(v, c);

export function Overview({ base, enabled }: { base: Omit<ModuleCtx, "state">; enabled: ProfileModule[] }) {
  const { setNarrow } = useShell();
  const mods = enabled.map((m) => ({ m, def: moduleDef(m.id), ctx: { ...base, state: m.setup_state } as ModuleCtx }));
  const only = mods.length === 1 ? mods[0] : null;
  const minimal = !!only?.def.MinimalOverview && only.m.setup_state !== "empty";
  useEffect(() => {
    setNarrow(minimal);
    return () => setNarrow(false);
  }, [minimal, setNarrow]);
  const [hidden, setHidden] = useState(readHidden);
  if (minimal && only?.def.MinimalOverview) return <only.def.MinimalOverview ctx={only.ctx} />;

  const hide = (id: string, state: string) => {
    const next = { ...hidden, [`${base.slug}.${id}`]: state };
    setHidden(next);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const on = new Set(enabled.map((m) => m.id));
  const ready = mods.filter(({ m }) => m.setup_state !== "empty");
  const budget = mods.find(({ m }) => m.id === "budget" && m.setup_state !== "empty");
  type Slot = GridItem & { order: number };
  const slots: Slot[] = [];
  if (budget) {
    slots.push({ id: "budget", span: 1, order: 10, node: <BudgetMonthWidget ctx={budget.ctx} /> });
    slots.push({ id: "subs", span: 1, order: 80, node: <SubscriptionsWidget ctx={budget.ctx} /> });
  }
  for (const { def, ctx } of ready) {
    for (const s of def.overview ?? []) {
      if (s.needs?.some((id) => !on.has(id))) continue;
      slots.push({ id: `${def.id}.${s.id}`, span: s.span, order: s.order, stack: s.stack, node: <s.Widget ctx={ctx} /> });
    }
  }
  mods.filter(({ m }) => m.setup_state !== "ready" && hidden[`${base.slug}.${m.id}`] !== m.setup_state).forEach(({ m, def }, k) => {
    slots.push({ id: `pending.${m.id}`, span: 1, order: 35 + k / 10, node: <PendingWidget def={def} m={m} onHide={() => hide(m.id, m.setup_state)} /> });
  });
  slots.push({ id: "networth", span: 2, order: 40, node: <NetWorthWidget /> });
  slots.push({ id: "accounts", span: 2, order: 70, node: <AccountsWidget accounts={base.networth.accounts} categories={base.categories} onChanged={base.refresh} /> });
  slots.sort((a, b) => a.order - b.order);

  const items: GridItem[] = [{ id: "hero", span: 3, node: <NetHero base={base} mods={mods} /> }, ...slots];
  if (!enabled.length) {
    items.splice(1, 0, {
      id: "nomods", span: 3, node: (
        <Widget title="Moduły">
          <Empty title="Brak modułów."
            action={<button className="btn" onClick={() => base.go({ kind: "settings", section: "modules" })}>Włącz moduły</button>} />
        </Widget>
      ),
    });
  }
  return <Grid items={items} />;
}

/** Hero: net worth with the change since last month; assets, liabilities, home equity, module facts,
 * liquid money with months of spending; other currencies on the right, never converted. */
function NetHero({ base, mods }: { base: Omit<ModuleCtx, "state">; mods: { m: ProfileModule; def: ModuleDef; ctx: ModuleCtx }[] }) {
  const bd = base.summary.breakdown;
  const c = bd.currency;
  const series = useAsync(() => getSeries(base.slug, "monthly", "total"), [base.slug], { key: ck(base.slug, "series", "monthly", "total") });
  const pts = series.data?.points ?? [];
  const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
  const last = pts.length ? pts[pts.length - 1] : null;
  const change = prev && last ? last.value - prev.value : null;
  const changePct = prev && change != null && prev.value ? change / Math.abs(prev.value) : null;
  const others = Object.entries(base.summary.networth).filter(([k]) => k !== c);
  const accounts = base.networth.accounts;
  // `is_liability` follows the account type since F6 (mortgage, loan, credit card); no balance-sign guess.
  const liabilities = accounts.filter((a) => a.is_liability && (a.balance ?? 0) !== 0 && a.currency === c);
  const liabNames = [...new Set(liabilities.map((a) => (TYPE_LABEL[a.type] ?? a.type).toLowerCase()))].slice(0, 2).join(", ");
  const liquid = accounts.filter((a) => LIQUID.has(a.type) && a.currency === c).reduce((s, a) => s + (a.balance ?? 0), 0);
  // Months of spending over complete months, never the running one (F7 FE10).
  const norm = useMonthNorm(base.slug, c);
  const spend = norm?.expense ?? null;
  const hasHome = bd.property || bd.mortgage;
  const delta: ReactNode = change != null && prev ? (
    <>
      <span className={change >= 0 ? "pos" : "neg"}>{change >= 0 ? "+" : ""}{whole(change, c)}{changePct != null ? ` (${pctSigned(changePct)})` : ""}</span>
      {" "}od {MONTH_GEN[Number(prev.date.slice(5, 7)) - 1]}
    </>
  ) : null;
  return (
    <section className="w hero" aria-label="Wartość netto">
      <div className="h1">
        <div className="l">Wartość netto</div>
        <div className="v">{cur(bd.net, c)}</div>
        {delta && <div className="d">{delta}</div>}
      </div>
      <div className="hf">
        <Fact label="Aktywa" value={whole(bd.assets, c)} detail={`${nAccounts(accounts.length)} · ${nModules(mods.length)}`} />
        {bd.liabilities > 0 && <Fact label="Zobowiązania" value={whole(-bd.liabilities, c)} detail={liabNames || undefined} />}
        {hasHome ? <Fact label="Home equity" value={whole(bd.home_equity, c)} detail="nieruchomość - hipoteka" /> : null}
        {mods.filter(({ m, def }) => def.HeroFact && m.setup_state !== "empty").map(({ def, ctx }) => def.HeroFact && <def.HeroFact key={def.id} ctx={ctx} />)}
        <Fact label="Płynne" value={whole(liquid, c)} title={spend && norm ? normTitle(norm) : undefined}
          detail={spend ? `${(liquid / spend).toLocaleString("pl-PL", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} mies. wydatków` : "konta i gotówka"} />
      </div>
      {others.length > 0 && (
        <div className="hr">
          <span className="tag">inne waluty: {others.map(([k, v]) => cur(v, k)).join(" · ")}</span>
          <div className="meta">bez przeliczenia</div>
        </div>
      )}
    </section>
  );
}
