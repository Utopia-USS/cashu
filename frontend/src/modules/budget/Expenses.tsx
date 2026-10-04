import { useEffect, useMemo, useState } from "react";
import type { Category } from "../../core/api";
import { j } from "../../core/api";
import { useSlug } from "../../core/context";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { Seg, Skeleton } from "../../ui";
import type { DrillRow } from "./api";
import { drillUrl, getCashflow, getSpending, postMerchantCategory, postTxnCategory } from "./api";
import { SpendingDonut } from "./SpendingDonut";

const MPL = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Mode = "month" | "quarter" | "year" | "all";
interface Period { year: number | null; month: number | null; quarter: number | null }

function periodQuery(p: Period): string {
  const sp = new URLSearchParams();
  if (p.year) sp.set("year", String(p.year));
  if (p.month) sp.set("month", String(p.month));
  if (p.quarter) sp.set("quarter", String(p.quarter));
  const s = sp.toString();
  return s ? "?" + s : "";
}

interface Toast { text: string; action?: { label: string; run: () => void } }

export function Expenses({ categories, onDataChanged }: { categories: Category[]; onDataChanged: () => void }) {
  const slug = useSlug();
  const { data: cashflow } = useAsync(() => getCashflow(slug, 240), [slug]);
  const labelFor = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, c.label]));
    return (k: string) => m.get(k) ?? k;
  }, [categories]);

  const bounds = useMemo(() => {
    const yms = (cashflow ?? []).map((r) => {
      const [y, mo] = r.label.split("-").map(Number);
      return y * 12 + (mo - 1);
    });
    if (!yms.length) return null;
    const minYM = Math.min(...yms), maxYM = Math.max(...yms);
    return { minYM, maxYM, minYear: Math.floor(minYM / 12), maxYear: Math.floor(maxYM / 12) };
  }, [cashflow]);

  const [mode, setMode] = useState<Mode>("month");
  const [ym, setYm] = useState<number | null>(null);
  const [q, setQ] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);

  if (bounds && ym == null) {
    setYm(bounds.maxYM);
    setQ(bounds.maxYear * 4 + 3);
    setYear(bounds.maxYear);
  }

  const period: Period = useMemo(() => {
    if (!bounds) return { year: null, month: null, quarter: null };
    if (mode === "month" && ym != null) {
      const c = clamp(ym, bounds.minYM, bounds.maxYM);
      return { year: Math.floor(c / 12), month: (c % 12) + 1, quarter: null };
    }
    if (mode === "quarter" && q != null) {
      const c = clamp(q, bounds.minYear * 4, bounds.maxYear * 4 + 3);
      return { year: Math.floor(c / 4), month: null, quarter: (c % 4) + 1 };
    }
    if (mode === "year" && year != null) {
      return { year: clamp(year, bounds.minYear, bounds.maxYear), month: null, quarter: null };
    }
    return { year: null, month: null, quarter: null };
  }, [mode, ym, q, year, bounds]);

  const label = useMemo(() => {
    if (mode === "all") return "Cały okres";
    if (mode === "month" && period.month) return `${MPL[period.month - 1]} ${period.year}`;
    if (mode === "quarter" && period.quarter) return `Q${period.quarter} ${period.year}`;
    if (mode === "year") return `${period.year}`;
    return "";
  }, [mode, period]);

  const qs = periodQuery(period);
  const { data: spending, reload: reloadSpending } = useAsync(() => getSpending(slug, qs), [slug, qs]);

  const canNav = mode !== "all";
  const step = (d: number) => {
    if (mode === "month") setYm((v) => (v ?? 0) + d);
    else if (mode === "quarter") setQ((v) => (v ?? 0) + d);
    else if (mode === "year") setYear((v) => (v ?? 0) + d);
  };
  const switchMode = (nm: Mode) => {
    if (bounds && ym != null) {
      const y = Math.floor(ym / 12), m = ym % 12;
      if (nm === "quarter") setQ(y * 4 + Math.floor(m / 3));
      if (nm === "year") setYear(y);
    }
    setMode(nm);
  };

  // Drill-down ----------------------------------------------------------------
  const [drill, setDrill] = useState<{ key: string; label: string } | null>(null);
  const [sort, setSort] = useState("date");
  const [order, setOrder] = useState("desc");
  const { data: drillRows, reload: reloadDrill } = useAsync(
    () => (drill ? j<DrillRow[]>(drillUrl(slug, drill.key, { sort, order, ...period })) : Promise.resolve([] as DrillRow[])),
    [drill?.key, sort, order, qs],
  );

  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  // Manual change affects ONLY this transaction; offer to apply to the whole merchant.
  const markCategory = async (row: DrillRow, category: string) => {
    await postTxnCategory(slug, row.id, category);
    reloadDrill();
    reloadSpending();
    if (category === "cash_withdrawal") { onDataChanged(); return; }
    if (!row.merchant_key) return;
    const name = row.counterparty || row.merchant || row.merchant_key;
    setToast({
      text: `Zmieniono na „${labelFor(category)}" (ta transakcja).`,
      action: {
        label: `Ustaw dla wszystkich: ${name}`,
        run: async () => {
          const res = await postMerchantCategory(slug, row.merchant_key, category);
          reloadDrill();
          reloadSpending();
          setToast({ text: `Ustawiono „${labelFor(category)}" dla ${res.updated ?? 0} transakcji sprzedawcy.` });
        },
      },
    });
  };

  const drillOpts = [
    ...categories.filter((c) => c.kind !== "transfer"),
    { key: "cash_withdrawal", label: "💵 Wypłata gotówki (do puli)", kind: "transfer" },
  ];

  return (
    <>
      <div className="card chart-card">
        <div className="controls">
          <strong style={{ fontSize: 14 }}>Na co idą pieniądze</strong>
          <span className="spacer" />
          <Seg<Mode>
            items={[["Miesiąc", "month"], ["Kwartał", "quarter"], ["Rok", "year"], ["Wszystko", "all"]]}
            value={mode} onChange={switchMode}
          />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button className="btn" style={{ visibility: canNav ? "visible" : "hidden" }} onClick={() => step(-1)}>‹</button>
            <span style={{ minWidth: 96, textAlign: "center", fontSize: 13, fontWeight: 550 }}>{label}</span>
            <button className="btn" style={{ visibility: canNav ? "visible" : "hidden" }} onClick={() => step(1)}>›</button>
          </span>
        </div>
        {spending
          ? <SpendingDonut rows={spending} onDrill={(key, l) => setDrill({ key, label: l })} />
          : <Skeleton w="100%" h={340} />}
      </div>

      {drill && (
        <div className="card chart-card">
          <div className="controls">
            <strong style={{ fontSize: 14 }}>Transakcje — {drill.label}</strong>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>sortuj:</span>
            <Seg items={[["Data", "date"], ["Kwota", "amount"]]} value={sort} onChange={setSort} />
            <Seg items={[["malejąco", "desc"], ["rosnąco", "asc"]]} value={order} onChange={setOrder} />
            <button className="btn" onClick={() => setDrill(null)}>✕</button>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Data</th><th>Sprzedawca</th><th>Konto</th><th className="num">Kwota</th><th>Kategoria</th></tr>
              </thead>
              <tbody>
                {drillRows == null ? (
                  Array.from({ length: 4 }, (_, i) => (
                    <tr key={i}>{Array.from({ length: 5 }, (_, k) => (
                      <td key={k}><Skeleton h={12} w={k === 1 ? "80%" : "60%"} /></td>
                    ))}</tr>
                  ))
                ) : !drillRows.length ? (
                  <tr><td colSpan={5} className="muted">Brak transakcji w tym okresie.</td></tr>
                ) : drillRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>
                      {r.merchant || "—"}
                      {r.details && <div className="muted" style={{ fontSize: 12 }}>{r.details}</div>}
                    </td>
                    <td className="muted">{r.account || "—"}</td>
                    <td className={`num ${r.amount < 0 ? "neg" : ""}`}>{cur(r.amount, r.currency)}</td>
                    <td>
                      <select value={r.category} onChange={(e) => markCategory(r, e.target.value)}>
                        {drillOpts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast">
          <span className="txt">{toast.text}</span>
          {toast.action && <button className="btn primary" onClick={toast.action.run}>{toast.action.label}</button>}
          <button className="icon-btn" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </>
  );
}
