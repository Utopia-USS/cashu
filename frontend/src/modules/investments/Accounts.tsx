// Konta i brokerzy: value and share per brokerage account with the broker snapshot's age.
import { AllocBar } from "../../ui";
import type { AccountRow } from "./api";
import { accountLabel, dm, money, pct } from "./labels";
import { daysBetween } from "./logic";

export function AccountsPanel({ accounts, base, today, filter, onAdd, onReconcile }: {
  accounts: AccountRow[]; base: string; today: string; filter: number | null; onAdd: () => void; onReconcile: (accountId: number) => void;
}) {
  return (
    <section className="card chart-card" id="inv-accounts">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Konta i brokerzy</h2>
        <span className="spacer" />
        <button className="btn" onClick={onAdd}>Dodaj rachunek</button>
      </div>
      {accounts.map((a) => {
        const age = a.snapshot_date ? daysBetween(a.snapshot_date, today) : null;
        const old = age != null && age > 14;
        const dimmed = filter != null && filter !== a.id;
        const importer = a.importer === "generic_csv" ? "CSV" : a.importer === "finanse" ? "format finanse" : null;
        return (
          <div className="acc-row" key={a.id} style={dimmed ? { opacity: 0.55 } : undefined}>
            <span title={a.name}>{accountLabel(a, accounts)}</span>
            <AllocBar current={a.share ?? 0} max={1} color="var(--nw)" height={10} />
            <span className="num">{money(a.value ?? null, base)}</span>
            <span className="num">{pct(a.share ?? null)}</span>
            <span className={`hint ${old ? "warn" : ""}`}>
              {a.snapshot_date
                ? <>snapshot{old ? "" : " brokera"} {dm(a.snapshot_date)} · {old ? <button className="lnk" style={{ fontSize: 12, color: "var(--warn)" }} onClick={() => onReconcile(a.id)}>uzgodnij</button> : importer ?? "import"}</>
                : a.last_import ? `bez snapshotu · import ${dm(a.last_import.at)}` : "bez importu"}
            </span>
          </div>
        );
      })}
      {!accounts.length && <div className="muted" style={{ fontSize: 13 }}>Brak rachunków maklerskich.</div>}
    </section>
  );
}
