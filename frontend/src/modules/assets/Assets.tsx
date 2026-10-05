import type { Account } from "../../core/api";
import { useShell } from "../../core/context";
import { cur, plural, TYPE_LABEL } from "../../format";
import { Empty } from "../../ui";

/** Manually valued assets (property, vehicles, other manual positions). */
export const isAsset = (a: Account) =>
  a.type === "property" || a.type === "vehicle" || (a.bank === "manual" && a.type === "other" && !a.is_liability);

export function Assets({ accounts }: { accounts: Account[] }) {
  const { go } = useShell();
  const items = accounts.filter(isAsset).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
  return (
    <section className="card chart-card">
      <div className="controls">
        <h2 style={{ margin: 0 }}>Majątek</h2>
        <span className="tag">{plural(items.length, "pozycja", "pozycje", "pozycji")}</span>
      </div>
      {!items.length ? (
        <Empty title="Brak pozycji." action={<button className="btn" onClick={() => go({ kind: "setup", module: "assets" })}>Konfiguracja</button>} />
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Pozycja</th><th>Typ</th><th className="num">Wartość</th><th>Wycena</th></tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{TYPE_LABEL[a.type] || a.type}</td>
                  <td className="num">{cur(a.balance, a.currency)}</td>
                  <td className="muted">{a.as_of ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
