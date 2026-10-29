import { useState } from "react";
import type { Category } from "../core/api";
import { deleteCashTxn, getCash, postCashExpense } from "../core/api";
import { useSlug } from "../core/context";
import { cur } from "../format";
import { useAsync } from "../hooks";
import { ck } from "../swr";
import { Skeleton } from "../ui";
import { errorText } from "../core/messages";
import { C } from "../common.strings.ts";
import { S } from "./CashCard.strings.ts";

export function CashCard({ categories, onChanged }: { categories: Category[]; onChanged: () => void }) {
  const slug = useSlug();
  const { data, reload } = useAsync(() => getCash(slug), [slug], { key: ck(slug, "cash") });
  const expenseCats = categories.filter((c) => c.kind === "expense");
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("groceries");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => { reload(); onChanged(); };

  const add = async () => {
    const amt = parseFloat(amount);
    if (!(amt > 0) || !title.trim()) { setErr(S.needAmountTitle); return; }
    setBusy(true); setErr(null);
    try {
      const res = await postCashExpense(slug, { amount: amt, title: title.trim(), category });
      if (res.error) { setErr(res.error); return; }
      setAmount(""); setTitle("");
      refresh();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  const del = async (id: number) => {
    try { await deleteCashTxn(slug, id); refresh(); } catch (e) { setErr(errorText(e)); }
  };

  const c = data?.currency || "PLN";

  return (
    <section className="card chart-card">
      <div className="controls">
        <strong style={{ fontSize: 14 }} title={S.cashHint}>{S.cash}</strong>
        {data
          ? <span style={{ fontSize: 15, fontWeight: 650 }} className={data.balance < 0 ? "neg" : ""}>{cur(data.balance, c)}</span>
          : <Skeleton w={90} h={18} />}
        <span className="spacer" />
        {data
          ? <span className="muted" style={{ fontSize: 12 }}>{S.withdrawnSpent(cur(data.withdrawals, c), cur(data.expenses, c))}</span>
          : <Skeleton w={180} h={12} />}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <input type="number" step="0.01" min="0" placeholder={S.amount} style={{ width: 110 }}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input type="text" placeholder={S.title} style={{ flex: 1, minWidth: 140 }}
          value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {expenseCats.map((cat) => <option key={cat.key} value={cat.key}>{cat.label}</option>)}
        </select>
        <button className="btn primary" onClick={add} disabled={busy}>{C.add}</button>
      </div>

      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="scroll tall">
        <table>
          <thead>
            <tr><th>{S.date}</th><th>{S.title}</th><th>{S.category}</th><th className="num">{S.amount}</th><th /></tr>
          </thead>
          <tbody>
            {!data ? (
              Array.from({ length: 3 }, (_, i) => (
                <tr key={i}>{Array.from({ length: 5 }, (_, k) => (
                  <td key={k}><Skeleton h={12} w={k === 1 ? "70%" : "50%"} /></td>
                ))}</tr>
              ))
            ) : !data.transactions.length ? (
              <tr><td colSpan={5} className="muted">{S.empty}</td></tr>
            ) : data.transactions.map((t) => (
              <tr key={t.id}>
                <td>{t.date}</td>
                <td>{t.kind === "withdrawal" ? "⬇︎ " : ""}{t.title}</td>
                <td className="muted">{t.category_label || "-"}</td>
                <td className={`num ${t.amount < 0 ? "neg" : "pos"}`}>{cur(t.amount, c)}</td>
                <td className="num"><button className="icon-btn" title={C.remove} onClick={() => del(t.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
