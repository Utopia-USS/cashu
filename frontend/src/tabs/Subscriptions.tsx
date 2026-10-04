import { getRecurring } from "../api";
import { cur } from "../format";
import { useAsync } from "../hooks";
import { SkeletonTable } from "../ui";

export function Subscriptions() {
  const { data } = useAsync(getRecurring, []);
  if (!data) return <SkeletonTable rows={8} />;
  const items = data.items ?? [];

  return (
    <section className="card chart-card">
      <h2>Subskrypcje / płatności cykliczne</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Odbiorca</th><th className="num">Kwota</th><th className="num">Co</th><th>Ostatnio</th></tr>
          </thead>
          <tbody>
            {!items.length ? (
              <tr><td colSpan={4} className="muted">Brak wykrytych płatności cyklicznych.</td></tr>
            ) : items.map((r, i) => (
              <tr key={i}>
                <td>{r.payee} {r.active && <span className="tag live">aktywna</span>}</td>
                <td className="num">{cur(r.amount, r.currency)}</td>
                <td className="num">{r.gap_days}d</td>
                <td className="muted">{r.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
