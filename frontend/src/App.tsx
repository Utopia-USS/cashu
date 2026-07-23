import { useState } from "react";
import { getCategories, getNetworth, getSummary, postResync } from "./api";
import { useAsync } from "./hooks";
import { Expenses } from "./tabs/Expenses";
import { Flows } from "./tabs/Flows";
import { Loan } from "./tabs/Loan";
import { Overview } from "./tabs/Overview";
import { Subscriptions } from "./tabs/Subscriptions";
import { SkeletonChart, SkeletonKpis } from "./ui";

type Tab = "overview" | "expenses" | "flows" | "subs" | "loan";
const TABS: [Tab, string][] = [
  ["overview", "Przegląd"], ["expenses", "Wydatki"], ["flows", "Przepływy"],
  ["subs", "Subskrypcje"], ["loan", "Kredyt"],
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [nonce, setNonce] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const summaryS = useAsync(getSummary, []);
  const networthS = useAsync(getNetworth, []);
  const catsS = useAsync(getCategories, []);

  const refreshAll = () => {
    summaryS.reload();
    networthS.reload();
    setNonce((n) => n + 1); // remount active tab so its local data refetches
  };

  const resync = async () => {
    setSyncing(true); setErr(null); setSyncMsg(null);
    try {
      const res = await postResync();
      if (!res.ok) { setErr(res.error || "Synchronizacja nieudana."); return; }
      let msg = `wgrano ${res.inserted} nowych transakcji`;
      if (res.pairs) msg += `, ${res.pairs} przelewów wewn.`;
      if (res.errors?.length) msg += ` — ${res.errors.length} konto/a pominięte (limit banku)`;
      setSyncMsg(msg);
      refreshAll();
    } catch (e) { setErr((e as Error).message); } finally { setSyncing(false); }
  };

  const loadError = summaryS.error || networthS.error || catsS.error;
  const ready = summaryS.data && networthS.data && catsS.data;
  const asof = networthS.data?.accounts
    .map((a) => a.as_of).filter(Boolean).sort().at(-1);

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>finanse</h1>
          <div className="sub">{syncMsg ? syncMsg + " · odświeżono" : asof ? `ostatnie dane: ${asof}` : "ładowanie…"}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {networthS.data && <span className="tag">{networthS.data.accounts.length} kont</span>}
          <button className="btn" onClick={resync} disabled={syncing} title="Pobierz nowe transakcje z banków (Enable Banking)">
            {syncing ? "Synchronizuję…" : "↻ Synchronizuj"}
          </button>
        </div>
      </header>

      {(err || loadError) && <div className="err">Błąd: {err || loadError}</div>}

      <nav className="tabbar">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tabbtn ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {!ready ? (
        <><SkeletonKpis /><SkeletonChart /></>
      ) : (
        <div key={nonce}>
          {tab === "overview" && (
            <Overview summary={summaryS.data!} networth={networthS.data!} categories={catsS.data!} onRefresh={refreshAll} />
          )}
          {tab === "expenses" && <Expenses categories={catsS.data!} onDataChanged={refreshAll} />}
          {tab === "flows" && <Flows />}
          {tab === "subs" && <Subscriptions />}
          {tab === "loan" && <Loan />}
        </div>
      )}
    </div>
  );
}
