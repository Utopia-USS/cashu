// Merchants without a category (design/v3/first-steps section 5): the largest totals first in the budget's
// currency, one select per merchant; a choice saves a merchant rule at once (it also covers future imports).
// Rows stay put while the drawer is open (no jumping); the list re-reads on the next open.
import { useRef, useState } from "react";
import type { Category } from "../../core/api";
import { errorText } from "../../core/messages";
import { cur0s, plural } from "../../format";
import { useAsync } from "../../hooks";
import { Drawer, Notice, Skeleton, Tag, useToast } from "../../ui";
import { getUncategorized, postMerchantCategory, type UncategorizedRow } from "./api";
import { useBudgetCurrency } from "./currency";
import { recategorized } from "./logic";

export function CategoriesDrawer({ slug, categories, onClose }: {
  slug: string;
  categories: Category[];
  /** `changed`: at least one rule was saved. */
  onClose: (changed: boolean) => void;
}) {
  const toast = useToast();
  const bc = useBudgetCurrency();
  const list = useAsync(() => (bc.ready ? getUncategorized(slug, 30, bc.currency) : Promise.resolve(null)), [slug, bc.ready, bc.currency]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const changed = useRef(false);
  const rows = list.data ?? null;
  const expense = categories.filter((c) => c.kind === "expense");
  const other = categories.filter((c) => c.kind !== "expense");
  const labelOf = (k: string) => categories.find((c) => c.key === k)?.label ?? k;

  const choose = async (r: UncategorizedRow, category: string) => {
    if (!category) return;
    setPicked((p) => ({ ...p, [r.merchant_key]: category }));
    setSaved((s) => ({ ...s, [r.merchant_key]: false }));
    setErr(null);
    try {
      const res = await postMerchantCategory(slug, r.merchant_key, category) as { updated?: number; error?: string };
      if (res.error) throw new Error(res.error);
      changed.current = true;
      recategorized(slug);
      setSaved((s) => ({ ...s, [r.merchant_key]: true }));
      toast(`${r.sample} → ${labelOf(category)} · ${plural(res.updated ?? 0, "transakcja", "transakcje", "transakcji")}`, 2500);
    } catch (e) {
      setErr(`Nie zapisano: ${errorText(e)}`);
    }
  };
  const close = () => onClose(changed.current);

  return (
    <Drawer open title="Kategorie" label="Kategorie wydatków" width={560} onClose={close}
      tag={rows ? <Tag>{plural(rows.length, "sprzedawca bez kategorii", "sprzedawców bez kategorii", "sprzedawców bez kategorii")}</Tag> : undefined}
      footer={<><span className="fhint">Reguła działa też dla przyszłych importów.</span><span style={{ flex: 1 }} /><button className="btn" onClick={close}>Zamknij</button></>}>
      {(err || (list.error && !rows)) && <Notice tone="neg">{err ?? list.error}</Notice>}
      {!rows ? (
        list.error ? null : <div style={{ display: "grid", gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={28} />)}</div>
      ) : !rows.length ? (
        <div className="empty">Wszyscy sprzedawcy mają kategorię.</div>
      ) : (
        <table>
          <thead><tr><th>Sprzedawca</th><th className="num">liczba</th><th className="num">suma</th><th>kategoria</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.merchant_key}>
                <td>
                  <b>{r.sample}</b>
                  {r.merchant_key !== r.sample && <div className="muted" style={{ fontSize: 12 }}>{r.merchant_key}</div>}
                </td>
                <td className="num">{r.count}</td>
                <td className="num">{cur0s(r.total, r.currency)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <select aria-label={`Kategoria: ${r.sample}`} value={picked[r.merchant_key] ?? ""} onChange={(e) => void choose(r, e.target.value)}>
                    <option value="">wybierz…</option>
                    {expense.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    {other.length > 0 && <optgroup label="Przychody">{other.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup>}
                  </select>
                  {saved[r.merchant_key] && <> <Tag tone="pos">zapisano</Tag></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
