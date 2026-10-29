import { useSlug } from "../../core/context";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { SkeletonTable } from "../../ui";
import { getRecurring } from "./api";
import { S } from "./Subscriptions.strings.ts";

export function Subscriptions() {
  const slug = useSlug();
  const { data } = useAsync(() => getRecurring(slug), [slug], { key: ck(slug, "budget", "recurring") });
  if (!data) return <SkeletonTable rows={8} />;
  const items = data.items ?? [];

  return (
    <section className="card chart-card">
      <h2>{S.title}</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>{S.payee}</th><th className="num">{S.amount}</th><th className="num">{S.every}</th><th>{S.last}</th></tr>
          </thead>
          <tbody>
            {!items.length ? (
              <tr><td colSpan={4} className="muted">{S.none}</td></tr>
            ) : items.map((r, i) => (
              <tr key={i}>
                <td>{r.payee} {r.active && <span className="tag live">{S.active}</span>}</td>
                <td className="num">{cur(r.amount, r.currency)}</td>
                <td className="num">{S.days(r.gap_days)}</td>
                <td className="muted">{r.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
