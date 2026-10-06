// Loans drawers (design/v3/first-steps sections 8, 9): a new loan (the fields of `cashu loans add`, with the
// instalment preview) and the installment matching (`set-payment`: a title phrase or the bank's IBAN, with the
// recent regular payments as phrase candidates).
import { useState } from "react";
import { describeError, errorText, label } from "../../core/messages";
import { cur, plural } from "../../format";
import { useAsync } from "../../hooks";
import { todayLocal } from "../../time";
import { Drawer, Notice, Seg, Skeleton, Tag, useToast } from "../../ui";
import { getRecurring } from "../budget/api";
import { type LoanInfo, loanName, patchLoanPayment, postLoan } from "./api";
import { annuity, firstOfMonth, installmentCandidates, parseNum, type TermUnit, termMonths, validateLoan } from "./logic";

const dmShort = (iso: string) => `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}`;

export function LoanDrawer({ slug, base, onClose, onSaved }: {
  slug: string; base: string; onClose: () => void; onSaved: (loan: LoanInfo) => void;
}) {
  const today = todayLocal();
  const [name, setName] = useState("");
  const [type, setType] = useState<"mortgage" | "loan">("mortgage");
  const [principal, setPrincipal] = useState("");
  const [currency, setCurrency] = useState(base);
  const [rate, setRate] = useState("");
  const [term, setTerm] = useState("");
  const [unit, setUnit] = useState<TermUnit>("years");
  const [start, setStart] = useState(firstOfMonth(today));
  const [origination, setOrigination] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const currencies = [...new Set([base, "PLN", "EUR", "USD", "CHF"])];
  const draft = { name, principal: parseNum(principal), rate: parseNum(rate), term: parseNum(term), unit, start, origination };
  const errors = validateLoan(draft);
  const months = draft.term != null ? termMonths(draft.term, unit) : null;
  const preview = !errors.principal && !errors.rate && !errors.term && months
    ? `rata ≈ ${cur(Math.round(annuity(draft.principal!, draft.rate!, months) * 100) / 100, currency)} · ${plural(months, "rata", "raty", "rat")}`
    : "";
  const fe = (k: keyof typeof errors) => (touched && errors[k] ? <span className="fe">{errors[k]}</span> : null);

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length || !months) return;
    setBusy(true); setErr(null);
    try {
      const loan = await postLoan(slug, {
        name: name.trim(), type, principal: draft.principal!, annual_rate: draft.rate!, term_months: months,
        start_date: start, origination_date: origination || null, currency,
      });
      onSaved(loan);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      setErr(code === "loan_name_taken" || code === "name_taken" ? label("error.loan_name_taken") : errorText(e));
      setBusy(false);
    }
  };

  return (
    <Drawer open title="Dodaj kredyt" label="Dodaj kredyt" width={520} onClose={onClose}
      footer={<><span className="fhint">{preview}</span><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Anuluj</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "Zapisuję…" : "Dodaj"}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="field">
        <label htmlFor="ln-name">Nazwa</label>
        <input id="ln-name" value={name} placeholder="Hipoteka" maxLength={60} autoComplete="off" data-autofocus onChange={(e) => setName(e.target.value)} />
        {fe("name")}
      </div>
      <div className="field">
        <label>Typ</label>
        <div><Seg<"mortgage" | "loan"> label="Typ" items={[["Hipoteka", "mortgage"], ["Kredyt", "loan"]]} value={type} onChange={setType}
          title="Hipoteka = kredyt zabezpieczony nieruchomością; Kredyt = samochodowy, gotówkowy, ratalny" /></div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-p">Kwota kredytu</label>
          <input id="ln-p" className="num" inputMode="decimal" autoComplete="off" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          {fe("principal")}
        </div>
        <div className="field">
          <label htmlFor="ln-c">Waluta</label>
          <select id="ln-c" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-r">Oprocentowanie (% rocznie)</label>
          <input id="ln-r" className="num" inputMode="decimal" autoComplete="off" placeholder="6,5" value={rate} onChange={(e) => setRate(e.target.value)} />
          {fe("rate")}
        </div>
        <div className="field">
          <label htmlFor="ln-t">Okres</label>
          <div className="inline">
            <input id="ln-t" className="num" inputMode="numeric" autoComplete="off" value={term} onChange={(e) => setTerm(e.target.value)} />
            <Seg<TermUnit> quiet label="Jednostka" items={[["lat", "years"], ["mies.", "months"]]} value={unit} onChange={setUnit} />
          </div>
          {fe("term")}
        </div>
      </div>
      <div className="fhint" style={{ margin: "-6px 0 12px" }}>Przy zmiennej stopie: dzisiejsza; zmianę zapiszesz później.</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-s">Pierwsza rata</label>
          <input id="ln-s" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          {fe("start")}
        </div>
        <div className="field">
          <label htmlFor="ln-o">Wypłata kredytu (opcjonalnie)</label>
          <input id="ln-o" type="date" value={origination} title="Od tej daty istnieje dług; puste = tak jak pierwsza rata" onChange={(e) => setOrigination(e.target.value)} />
          {fe("origination")}
        </div>
      </div>
    </Drawer>
  );
}

type Mode = "text" | "iban";

export function InstallmentDrawer({ slug, loans, initialId, onClose, onSaved }: {
  slug: string; loans: LoanInfo[]; initialId: number | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const withId = loans.filter((l) => l.id != null);
  const [id, setId] = useState<number | null>(initialId ?? withId[0]?.id ?? null);
  const loan = withId.find((l) => l.id === id) ?? null;
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState(loan?.payment_text ?? "");
  const [iban, setIban] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rec = useAsync(() => getRecurring(slug), [slug]);
  const candidates = installmentCandidates(rec.data?.items ?? []);
  const value = mode === "text" ? text : iban;
  const stored = mode === "text" ? !!loan?.payment_text : !!loan?.payment_iban_tail;

  const pick = (lid: number) => {
    setId(lid);
    setText(withId.find((l) => l.id === lid)?.payment_text ?? "");
    setIban("");
  };
  const send = async (v: string) => {
    if (loan?.id == null) return;
    setBusy(true); setErr(null);
    try {
      const r = await patchLoanPayment(slug, loan.id, mode === "text" ? { text: v } : { iban: v });
      if (!v) toast("Wyczyszczono", 2500);
      else if (r.matched) toast(`Rozpoznano ${plural(r.matched, "ratę", "raty", "rat")}`, 3000);
      else toast("Zapisano · brak pasujących przelewów", 4000);
      onSaved();
    } catch (e) {
      setErr(describeError(e).text);
      setBusy(false);
    }
  };

  return (
    <Drawer open title="Rozpoznawanie rat" label="Rozpoznawanie rat" width={520} onClose={onClose}
      tag={loan ? <Tag>{loanName(loan, withId.indexOf(loan))}</Tag> : undefined}
      footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Anuluj</button>
        <button className="btn primary" disabled={busy || !value.trim() || !loan} onClick={() => void send(value.trim())}>{busy ? "Zapisuję…" : "Zapisz"}</button></>}>
      {err && <Notice tone="neg">Nie zapisano: {err}</Notice>}
      {withId.length > 1 && (
        <div className="field">
          <label htmlFor="in-loan">Kredyt</label>
          <select id="in-loan" value={id ?? ""} onChange={(e) => pick(Number(e.target.value))}>
            {withId.map((l, i) => <option key={l.id} value={l.id}>{loanName(l, i)}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label>Sposób rozpoznania</label>
        <div><Seg<Mode> label="Sposób rozpoznania" items={[["Fraza z tytułu", "text"], ["IBAN banku", "iban"]]} value={mode} onChange={(m) => { setMode(m); setErr(null); }} /></div>
      </div>
      {mode === "text" ? (
        <>
          <div className="field">
            <label htmlFor="in-t">Fraza</label>
            <div className="inline">
              <input id="in-t" value={text} placeholder="RATA KREDYTU" maxLength={120} autoComplete="off" data-autofocus onChange={(e) => setText(e.target.value)} />
              {stored && <button className="lnk" disabled={busy} onClick={() => void send("")}>wyczyść</button>}
            </div>
            <span className="fhint">Wystarczy fragment tytułu albo nazwy odbiorcy; wielkość liter i polskie znaki nie mają znaczenia.</span>
          </div>
          {rec.loading && !rec.data ? <Skeleton h={36} /> : candidates.length > 0 && (
            <>
              <div className="kicker" style={{ margin: "14px 0 4px" }}>Ostatnie regularne płatności</div>
              {candidates.map((c) => (
                <div className="row" key={`${c.payee}|${c.currency}|${c.amount}`}>
                  <div className="grow">
                    <div className="t">{c.payee}</div>
                    <div className="d">{cur(Math.abs(c.amount), c.currency)} · co ok. {c.gap_days} dni · ostatnio {dmShort(c.last)}</div>
                  </div>
                  <button className="lnk" onClick={() => setText(c.payee)}>użyj</button>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <div className="field">
          <label htmlFor="in-i">IBAN banku (konto, na które idzie rata)</label>
          {loan?.payment_iban_tail && <span className="fhint">zapisany: …{loan.payment_iban_tail}</span>}
          <div className="inline">
            <input id="in-i" value={iban} autoComplete="off" inputMode="numeric" placeholder={loan?.payment_iban_tail ? "nowy numer" : undefined}
              onChange={(e) => setIban(e.target.value)} />
            {stored && <button className="lnk" disabled={busy} onClick={() => void send("")}>wyczyść</button>}
          </div>
          <span className="fhint">Zostaje tylko w aplikacji; agent AI widzi co najwyżej 4 ostatnie cyfry.</span>
        </div>
      )}
    </Drawer>
  );
}
