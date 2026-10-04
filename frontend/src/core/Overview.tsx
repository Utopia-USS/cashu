// Przegląd, composed: core KPIs + module KPIs, the net worth chart, one compact card
// per enabled module (overview widgets), then the core cards (breakdown, accounts, cash).
import { useState } from "react";
import { Accounts } from "../components/Accounts";
import { Breakdown } from "../components/Breakdown";
import { CashCard } from "../components/CashCard";
import { NetWorthChart } from "../components/NetWorthChart";
import { cur } from "../format";
import { useAsync } from "../hooks";
import { Empty, Kpi, Skeleton } from "../ui";
import { getSetup, type ProfileModule } from "./api";
import { moduleDef, tabKey } from "./registry";
import { stepsTag } from "./SetupPage";
import { useShell } from "./context";
import type { ModuleCtx, ModuleDef } from "./types";

const HIDDEN_KEY = "finanse.hiddenCards";
const readHidden = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || "{}"); } catch { return {}; }
};

export function Overview({ base, enabled }: { base: Omit<ModuleCtx, "state">; enabled: ProfileModule[] }) {
  const { summary } = base;
  // The headline is the profile's base currency (the backend builds the breakdown in
  // it). Every other currency keeps its own total next to it: never converted, never
  // summed into the headline, never hidden.
  const bd = summary.breakdown;
  const otherTotals = Object.entries(summary.networth).filter(([c]) => c !== bd.currency);
  const others = otherTotals.length
    ? `inne waluty (bez przeliczenia): ${otherTotals.map(([c, v]) => cur(v, c)).join(" · ")}`
    : "";
  const hasHome = bd.property || bd.mortgage;
  const [hidden, setHidden] = useState(readHidden);
  const hide = (id: string, state: string) => {
    const next = { ...hidden, [`${base.slug}.${id}`]: state };
    setHidden(next);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const mods = enabled.map((m) => ({ m, def: moduleDef(m.id), ctx: { ...base, state: m.setup_state } as ModuleCtx }));
  // A hidden "not set up" card comes back as soon as the module state changes.
  const visible = mods.filter(({ m }) => hidden[`${base.slug}.${m.id}`] !== m.setup_state);

  return (
    <>
      <div className="kpis">
        <Kpi label={`Net worth (${bd.currency})`} value={cur(bd.net, bd.currency)} hint={others} />
        <Kpi label="Aktywa" value={cur(bd.assets, bd.currency)} cls="pos" />
        <Kpi label="Zobowiązania" value={cur(bd.liabilities ? -bd.liabilities : 0, bd.currency)} cls={bd.liabilities > 0 ? "neg" : ""} />
        <Kpi
          label="Home equity"
          value={hasHome ? cur(bd.home_equity, bd.currency) : "-"}
          hint={hasHome ? "nieruchomość - hipoteka" : "brak nieruchomości w profilu"}
        />
        {mods.map(({ m, def, ctx }) => def.Kpis && <def.Kpis key={m.id} ctx={ctx} />)}
      </div>

      <NetWorthChart />

      <section className="card chart-card">
        <h2>Moduły</h2>
        {!enabled.length ? (
          <Empty
            title="Brak włączonych modułów."
            hint="Przegląd pokazuje wartość netto i gotówkę. Budżet, kredyty, majątek i inwestycje włączysz w Ustawieniach."
            action={<button className="btn" onClick={() => base.go({ kind: "settings", section: "modules" })}>Ustawienia → Moduły</button>}
          />
        ) : !visible.length ? (
          <div className="muted" style={{ fontSize: 13 }}>Karty modułów są ukryte do czasu zmiany ich stanu.</div>
        ) : (
          <div className="modgrid">
            {visible.map(({ m, def, ctx }) =>
              m.setup_state === "ready"
                ? <ModuleCard key={m.id} def={def} ctx={ctx} />
                : <PendingCard key={m.id} def={def} ctx={ctx} onHide={() => hide(m.id, m.setup_state)} />)}
          </div>
        )}
      </section>

      <Breakdown bd={bd} />
      <Accounts accounts={base.networth.accounts} />
      <CashCard categories={base.categories} onChanged={base.refresh} />
    </>
  );
}

/** Overview widget of a set-up module: title, status tag, 3 facts, link to its first tab. */
function ModuleCard({ def, ctx }: { def: ModuleDef; ctx: ModuleCtx }) {
  const first = def.tabs[0];
  return (
    <div className="card">
      <div className="mt">{def.name} {stepsTag(null, "ready")}</div>
      {def.Facts ? <def.Facts ctx={ctx} /> : <div className="muted" style={{ fontSize: 13 }}>{def.short}</div>}
      {first && (
        <div className="ml">
          <button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: tabKey(def.id, first.id) })}>{first.label} →</button>
        </div>
      )}
    </div>
  );
}

/** Dashed card of a module that is enabled but not (fully) set up: progress, next step. */
function PendingCard({ def, ctx, onHide }: { def: ModuleDef; ctx: ModuleCtx; onHide: () => void }) {
  const { slug } = useShell();
  const { data } = useAsync(() => getSetup(slug, def.id), [slug, def.id, ctx.state]);
  const done = data?.steps.filter((s) => s.status === "done") ?? [];
  const next = data?.steps.find((s) => s.status === "on") ?? data?.steps.find((s) => s.status !== "done");
  return (
    <div className="card pending">
      <div className="mt">{def.name} {stepsTag(data, ctx.state)}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {!data ? <Skeleton w="90%" h={12} /> : (
          <>
            {done.length ? `${done.map((s) => s.title).join(", ")}: zrobione. ` : ""}
            {next ? `Następny krok: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.` : "Moduł czeka na dane."}
          </>
        )}
      </div>
      <div className="controls ml" style={{ margin: 0 }}>
        <button className="btn primary" onClick={() => ctx.go({ kind: "setup", module: def.id })}>Kontynuuj konfigurację</button>
        <button className="btn" onClick={onHide}>Ukryj kartę</button>
      </div>
    </div>
  );
}
