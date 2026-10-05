// "Zamknięcie miesiąca": what the month earned, spent and left over in the chosen currency, the
// cushion top-up and the suggested transfer to investments vs the strategy's planned contribution.
import { useState } from "react";
import type { Account } from "../../core/api";
import { ApiError, j, pp } from "../../core/api";
import { useShell } from "../../core/context";
import { cur } from "../../format";
import { useAsync } from "../../hooks";
import { Notice, Seg, Skeleton, Switch, Tag } from "../../ui";
import type { CushionState, MonthClose } from "./api";
import { getBudgetSettings, getMonthClose, putBudgetSettings } from "./api";
import "./budget.css";
import type { BudgetCurrency } from "./currency";
import type { CushionDraft } from "./logic";
import { closeFor, cushionDraft, cushionPayload, monthLabel, planState, shiftMonth } from "./logic";

const TOP = 3;

export function MonthCloseCard({ bc }: { bc: BudgetCurrency }) {
  const { slug } = useShell();
  const [month, setMonth] = useState<string | null>(null); // null = the server's default month
  const { data: loaded, error, reload } = useAsync(
    // An older server without the endpoint (or the dev mock) answers 404: then no card at all.
    () => getMonthClose(slug, month).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return "unavailable" as const;
      throw e;
    }),
    [slug, month],
  );
  const [allCats, setAllCats] = useState(false);
  const [editing, setEditing] = useState(false);

  if (loaded === "unavailable") return null;
  if (error) return <Notice tone="warn">Nie wczytano zamknięcia miesiąca: {error}</Notice>;
  const data = loaded;
  if (!data) {
    return <section className="card chart-card"><Skeleton w={180} h={14} /><div style={{ height: 10 }} /><Skeleton h={54} /></section>;
  }
  const shown = bc.currency ?? data.base_currency;
  const { main, others } = closeFor(data, shown);
  const ym = data.month;
  const canPrev = !data.first_month || ym > data.first_month;
  const canNext = !!data.last_month && ym < data.last_month;
  const cats = main?.spending_by_category ?? [];
  const spendTotal = main?.spending ?? 0;
  const pct = (a: number) => (spendTotal ? Math.round((a / spendTotal) * 100) : 0);

  return (
    <section className="card chart-card" aria-label="Zamknięcie miesiąca">
      <div className="controls">
        <strong style={{ fontSize: 14 }}>Zamknięcie miesiąca</strong>
        {!data.complete && <Tag tone="warn">w toku</Tag>}
        <span className="spacer" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <button className="btn" disabled={!canPrev} aria-label="Poprzedni miesiąc" onClick={() => setMonth(shiftMonth(ym, -1))}>‹</button>
          <span style={{ minWidth: 96, textAlign: "center", fontSize: 13, fontWeight: 550 }}>{monthLabel(ym)}</span>
          <button className="btn" disabled={!canNext} aria-label="Następny miesiąc" onClick={() => setMonth(shiftMonth(ym, 1))}>›</button>
        </span>
      </div>

      {!main ? (
        <div className="muted" style={{ fontSize: 13 }}>Brak transakcji w {shown}.</div>
      ) : (
        <>
          <div className="mc-figs">
            <Fig label="Przychody" value={cur(main.income, shown)} cls="pos" />
            <Fig label="Wydatki" value={cur(main.spending, shown)} cls="neg" />
            <Fig label="Nadwyżka" value={cur(main.surplus, shown)} cls={main.surplus < 0 ? "neg" : "pos"} />
            <Fig
              label="Na inwestycje"
              value={cur(main.suggested_transfer, shown)}
              cls="nw"
              hint={main.cushion_top_up > 0 ? `po dopłacie do poduszki ${cur(main.cushion_top_up, shown)}` : "sugerowany przelew"}
            />
          </div>
          {cats.length > 0 && (
            <div className="mc-cats">
              Najwięcej: {cats.slice(0, TOP).map((c, i) => (
                <span key={c.category}>{i ? " · " : ""}{c.label} <b>{cur(c.amount, shown)}</b></span>
              ))}
              {cats.length > TOP && (
                <> · <button className="linkish" onClick={() => setAllCats((v) => !v)} aria-expanded={allCats}>
                  {allCats ? "zwiń" : `wszystkie (${cats.length})`}
                </button></>
              )}
              {allCats && (
                <div className="mc-all">
                  {cats.map((c) => (
                    <div key={c.category} className="legend-row">
                      <span style={{ color: "var(--text)" }}>{c.label}</span>
                      <span className="num" style={{ color: "var(--text)" }}>{cur(c.amount, shown)}</span>
                      <span className="num">{pct(c.amount)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="bd-sum">
        <CushionFact cushion={data.cushion} onEdit={() => setEditing((v) => !v)} editing={editing} />
        <PlanFact close={data} />
        {others.length > 0 && (
          <div>
            <span>Inne waluty</span>
            <b style={{ fontWeight: 550 }}>{others.map((o) => `${o.currency} ${cur(o.surplus, o.currency)}`).join(" · ")}</b>
          </div>
        )}
      </div>

      {editing && (
        <CushionForm
          currencies={bc.info?.currencies.map((c) => c.currency) ?? [data.base_currency]}
          baseCurrency={bc.info?.base ?? data.base_currency}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); reload(); }}
        />
      )}
    </section>
  );
}

function Fig({ label, value, cls, hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="mc-fig">
      <div className="l">{label}</div>
      <div className={`v ${cls ?? ""}`}>{value}</div>
      {hint && <div className="h">{hint}</div>}
    </div>
  );
}

function CushionFact({ cushion, editing, onEdit }: { cushion: CushionState | null; editing: boolean; onEdit: () => void }) {
  const edit = <button className="btn" style={{ marginLeft: 6, padding: "1px 8px", fontSize: 12 }} onClick={onEdit} aria-expanded={editing}>{editing ? "Zamknij" : "Ustaw"}</button>;
  if (!cushion) return <div><span>Poduszka finansowa</span><b style={{ fontWeight: 550 }}>wyłączona</b>{edit}</div>;
  const c = cushion.currency;
  const text = cushion.target == null
    ? "brak historii wydatków do celu"
    : cushion.reached
      ? `osiągnięta (${cur(cushion.balance, c)})`
      : `${cur(cushion.balance, c)} z ${cur(cushion.target, c)} · dopłata ${cur(cushion.top_up, c)}`;
  // The level is the balance at the month start plus the month's transfers to the cushion (F7 FXB V7).
  return <div><span>Poduszka finansowa</span><b style={{ fontWeight: 550 }} title="Saldo na początek miesiąca + przelewy w miesiącu">{text}</b>{edit}</div>;
}

function PlanFact({ close }: { close: MonthClose }) {
  const plan = planState(close.investing);
  if (plan.kind === "off") return null;
  if (plan.kind === "no_plan") {
    const why = plan.strategy === "missing" ? "brak strategii" : plan.strategy === "invalid" ? "strategia z błędami" : "brak contributions w strategii";
    return <div><span>Plan wpłat</span><b style={{ fontWeight: 550 }}>{why}</b></div>;
  }
  const c = plan.currency;
  return (
    <div>
      <span>Plan wpłat</span>
      <b style={{ fontWeight: 550 }}>{cur(plan.planned, c)} / mies.</b>{" "}
      {plan.kind === "covered"
        ? <Tag tone="pos">pokrywa plan{plan.difference > 0 ? ` (+${cur(plan.difference, c)})` : ""}</Tag>
        : <Tag tone="warn">{plan.hasData ? `brakuje ${cur(-plan.difference, c)}` : `brak danych w ${c}`}</Tag>}
    </div>
  );
}

function CushionForm({ currencies, baseCurrency, onClose, onSaved }: {
  currencies: string[]; baseCurrency: string; onClose: () => void; onSaved: () => void;
}) {
  const { slug } = useShell();
  const settings = useAsync(() => getBudgetSettings(slug), [slug]);
  const accounts = useAsync(() => j<Account[]>(pp(slug, "/accounts")), [slug]);
  const [draft, setDraft] = useState<CushionDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!draft && settings.data) setDraft(cushionDraft(settings.data.cushion, baseCurrency));
  if (settings.error) return <Notice tone="warn">Nie wczytano ustawień: {settings.error}</Notice>;
  if (!draft) return <div className="mc-form"><Skeleton h={60} /></div>;
  const set = (patch: Partial<CushionDraft>) => setDraft({ ...draft, ...patch });
  const choices = (accounts.data ?? []).filter(
    (a) => a.currency === draft.currency && !a.is_liability && ["checking", "savings", "cash"].includes(a.type),
  );
  const save = async () => {
    const p = cushionPayload(draft, baseCurrency);
    if (!p.ok) { setErr(p.error); return; }
    setBusy(true);
    setErr(null);
    try {
      await putBudgetSettings(slug, { cushion: p.value });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <div className="mc-form">
      <div className="controls" style={{ marginBottom: 8 }}>
        <Switch on={draft.enabled} onChange={(v) => set({ enabled: v })} label="Poduszka przed inwestycjami"
          title="Najpierw dopłać do poduszki, resztę nadwyżki przelej na inwestycje" />
        <span style={{ fontSize: 13 }} title="Najpierw dopłać do poduszki, resztę nadwyżki przelej na inwestycje">Poduszka przed inwestycjami</span>
      </div>
      {draft.enabled && (
        <div className="row">
          <div className="field">
            <label>Cel poduszki</label>
            <Seg<"amount" | "months"> items={[["Kwota", "amount"], ["Miesiące wydatków", "months"]]} value={draft.mode} onChange={(m) => set({ mode: m })} />
          </div>
          {draft.mode === "amount" ? (
            <div className="field">
              <label htmlFor="mc-amount">Kwota ({draft.currency})</label>
              <input id="mc-amount" inputMode="decimal" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} style={{ width: 130 }} />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="mc-months">Miesięcy wydatków</label>
              <input id="mc-months" inputMode="numeric" value={draft.months} onChange={(e) => set({ months: e.target.value })} style={{ width: 80 }} />
            </div>
          )}
          {currencies.length > 1 && (
            <div className="field">
              <label htmlFor="mc-cur">Waluta</label>
              <select id="mc-cur" value={draft.currency} onChange={(e) => set({ currency: e.target.value, accountIds: [] })}>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="mc-max">Maks. dopłata / mies.</label>
            <input id="mc-max" inputMode="decimal" value={draft.monthlyMax} onChange={(e) => set({ monthlyMax: e.target.value })} style={{ width: 130 }} />
          </div>
        </div>
      )}
      {draft.enabled && (
        <div className="field">
          <label title={`Domyślnie konta oszczędnościowe w ${draft.currency}; saldo na koniec miesiąca.`}>Konta</label>
          {choices.length ? (
            <div className="accounts">
              {choices.map((a) => (
                <label key={a.id}>
                  <input type="checkbox" checked={draft.accountIds.includes(a.id)}
                    onChange={(e) => set({ accountIds: e.target.checked ? [...draft.accountIds, a.id] : draft.accountIds.filter((i) => i !== a.id) })} />
                  {a.name}
                </label>
              ))}
            </div>
          ) : <span className="hint">Brak kont w {draft.currency}.</span>}
        </div>
      )}
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="controls" style={{ marginBottom: 0 }}>
        <button className="btn primary" disabled={busy} onClick={save}>Zapisz</button>
        <button className="btn" disabled={busy} onClick={onClose}>Anuluj</button>
      </div>
    </div>
  );
}
