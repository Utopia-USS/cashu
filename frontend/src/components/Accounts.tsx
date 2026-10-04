import { useState } from "react";
import type { Account } from "../core/api";
import { cur, TYPE_LABEL } from "../format";

const isEmpty = (a: Account) => a.balance == null || Math.abs(a.balance) < 0.005;

export function Accounts({ accounts }: { accounts: Account[] }) {
  const [showEmpty, setShowEmpty] = useState(false);
  const sorted = [...accounts].sort(
    (a, b) => (Number(isEmpty(a)) - Number(isEmpty(b))) || (Math.abs(b.balance || 0) - Math.abs(a.balance || 0)),
  );
  const empties = sorted.filter(isEmpty);
  const visible = showEmpty ? sorted : sorted.filter((a) => !isEmpty(a));

  return (
    <section className="card chart-card">
      <h2>Konta</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Konto</th><th>Typ</th><th className="num">Saldo / wkład</th></tr>
          </thead>
          <tbody>
            {!accounts.length && <tr><td colSpan={3} className="muted">Brak kont w tym profilu.</td></tr>}
            {visible.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name}
                  <div className="muted" style={{ fontSize: 12 }}>{a.bank} · …{a.iban_tail}</div>
                </td>
                <td>{TYPE_LABEL[a.type] || a.type}</td>
                <td className={`num ${(a.balance ?? 0) < 0 ? "neg" : ""} ${isEmpty(a) ? "muted" : ""}`}>
                  {cur(a.balance, a.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {empties.length > 0 && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setShowEmpty((s) => !s)}>
          {showEmpty ? "Ukryj puste konta" : `Pokaż puste konta (${empties.length})`}
        </button>
      )}
    </section>
  );
}
