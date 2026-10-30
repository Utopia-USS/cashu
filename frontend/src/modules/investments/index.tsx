import { useSlug } from "../../core/context";
import type { Fact, ModuleDef } from "../../core/types";
import { useAsync } from "../../hooks";
import { FactList, Kpi } from "../../ui";
import { getOverview } from "./api";
import { invKey } from "./v2/api";
import { dm, money, pct, RUN_STATUS } from "./labels";
import { S } from "./index.strings.ts";
import { InvestmentsV2 } from "./v2/Home";
import { InvestmentsStrategies } from "./v2/Strategies";
import { S as SS } from "./v2/Strategies.strings.ts";
import { InvestmentsHeaderTag, InvestmentsHeroFact, InvestmentsSummaryWidget, MinimalOverview, SurplusWidget } from "./v2/Overview";

// Frontend half of the investments module: the v2 home (widget grid on thirds, one tab, wide page) with
// its sub-pages (alerts manager, asset page), and the Strategie tab (strategy documents, docs/agents/strategies.md). The home renders its own first steps for an empty
// portfolio, so the shell's SetupPage is only reached through Przegląd / the setup view.

function InvestmentsKpis({ state, go }: { state: string; go: () => void }) {
  const slug = useSlug();
  // Same request and key as the v2 overview views (one JSON, typed twice).
  const q = useAsync(() => (state === "empty" ? Promise.resolve(null) : getOverview(slug, null)), [slug, state],
    { key: state === "empty" ? undefined : invKey(slug, "overview", "") });
  const k = q.data?.kpis;
  if (!k || !k.value.total) {
    return (
      <Kpi label={S.kpiPortfolio} value={<span className="muted">-</span>}
        hint={<>{state === "ready" ? S.noPositions : S.notConfigured} · <button className="lnk" style={{ fontSize: 12 }} onClick={go}>{state === "ready" ? S.open : S.configure}</button></>} />
    );
  }
  const base = q.data!.base_currency;
  return (
    <Kpi label={S.kpiPortfolioIn(base)} value={money(k.value.total, base)}
      hint={k.unrealized.pct != null ? S.fromCost(pct(k.unrealized.pct, true)) : undefined}
      hintCls={k.unrealized.pct == null ? undefined : k.unrealized.pct >= 0 ? "pos" : "neg"} />
  );
}

function InvestmentsFacts() {
  const slug = useSlug();
  const q = useAsync(() => getOverview(slug, null), [slug], { key: invKey(slug, "overview", "") });
  if (!q.data) return <FactList facts={q.error ? [] : null} />;
  const k = q.data.kpis;
  const c = q.data.base_currency;
  const facts: Fact[] = [
    [S.factValue, money(k.value.total, c)],
    [S.factSignals, k.signals.action ? S.signalsBoth(k.signals.action, k.signals.info) : S.signalsInfo(k.signals.info), k.signals.action ? "neg" : undefined],
  ];
  if (k.last_run) facts.push([S.factRules, `${dm(k.last_run.finished_at ?? k.last_run.started_at)} · ${RUN_STATUS[k.last_run.status === "ok" || k.last_run.status === "partial" ? k.last_run.status : "failed"]}`]);
  return <FactList facts={facts} />;
}

export const investments: ModuleDef = {
  id: "investments",
  get name() { return S.name; },
  get desc() { return S.desc; },
  get hint() { return S.hint; },
  get short() { return S.short; },
  get skillHint() { return S.skillHint; },
  ownSetup: true,
  tabs: [
    { id: "portfolio", get label() { return S.tab; }, wide: true, render: (ctx) => <InvestmentsV2 ctx={ctx} /> },
    { id: "strategies", get label() { return SS.tab; }, wide: true, render: () => <InvestmentsStrategies /> },
  ],
  Kpis: ({ ctx }) => <InvestmentsKpis state={ctx.state} go={() => ctx.go({ kind: "tab", tab: "investments.portfolio" })} />,
  Facts: InvestmentsFacts,
  overview: [
    { id: "surplus", span: 1, order: 20, needs: ["budget"], Widget: SurplusWidget },
    { id: "summary", span: 1, order: 30, Widget: InvestmentsSummaryWidget },
  ],
  HeroFact: InvestmentsHeroFact,
  MinimalOverview,
  HeaderTag: InvestmentsHeaderTag,
};
