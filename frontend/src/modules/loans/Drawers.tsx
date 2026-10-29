// Loans drawers (design/v3/first-steps sections 8, 9): a new loan (the fields of `cashu loans add`, with the
// instalment preview) and the installment matching (`set-payment`: a title phrase or the bank's IBAN, with the
// recent regular payments as phrase candidates).
import { useState } from "react";
import { describeError, errorText, label } from "../../core/messages";
import { C } from "../../common.strings.ts";
import { cur } from "../../format";
import { intlLocale, lang } from "../../i18n.ts";
import { useAsync } from "../../hooks";
import { todayLocal } from "../../time";
import { Drawer, Notice, Seg, Skeleton, Tag, useToast } from "../../ui";
import { getRecurring } from "../budget/api";
import { type LoanInfo, loanName, patchLoanPayment, postLoan } from "./api";
import { annuity, firstOfMonth, installmentCandidates, parseNum, type TermUnit, termMonths, validateLoan } from "./logic";
import { S } from "./Drawers.strings.ts";

/** "5.10" (English: "Oct 5") of "2026-10-05". */
const dmShort = (iso: string) => (lang() === "pl" ? `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}`
  : new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", timeZone: "UTC" })
    .format(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))));

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
    ? S.preview(cur(Math.round(annuity(draft.principal!, draft.rate!, months) * 100) / 100, currency), months)
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
      setErr((code === "loan_name_taken" || code === "name_taken" ? label("error.loan_name_taken") : null) ?? errorText(e));
      setBusy(false);
    }
  };

  return (
    <Drawer open title={S.addLoan} label={S.addLoan} width={520} onClose={onClose}
      footer={<><span className="fhint">{preview}</span><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.cancel}</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? S.saving : C.add}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="field">
        <label htmlFor="ln-name">{S.name}</label>
        <input id="ln-name" value={name} placeholder={S.namePlaceholder} maxLength={60} autoComplete="off" data-autofocus onChange={(e) => setName(e.target.value)} />
        {fe("name")}
      </div>
      <div className="field">
        <label>{S.type}</label>
        <div><Seg<"mortgage" | "loan"> label={S.type} items={[[S.mortgage, "mortgage"], [S.loan, "loan"]]} value={type} onChange={setType}
          title={S.typeTitle} /></div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-p">{S.principal}</label>
          <input id="ln-p" className="num" inputMode="decimal" autoComplete="off" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
          {fe("principal")}
        </div>
        <div className="field">
          <label htmlFor="ln-c">{S.currency}</label>
          <select id="ln-c" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-r">{S.rate}</label>
          <input id="ln-r" className="num" inputMode="decimal" autoComplete="off" placeholder={S.ratePlaceholder} value={rate} onChange={(e) => setRate(e.target.value)} />
          {fe("rate")}
        </div>
        <div className="field">
          <label htmlFor="ln-t">{S.term}</label>
          <div className="inline">
            <input id="ln-t" className="num" inputMode="numeric" autoComplete="off" value={term} onChange={(e) => setTerm(e.target.value)} />
            <Seg<TermUnit> quiet label={S.unit} items={[[S.years, "years"], [S.months, "months"]]} value={unit} onChange={setUnit} />
          </div>
          {fe("term")}
        </div>
      </div>
      <div className="fhint" style={{ margin: "-6px 0 12px" }}>{S.variableRate}</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ln-s">{S.firstInstallment}</label>
          <input id="ln-s" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          {fe("start")}
        </div>
        <div className="field">
          <label htmlFor="ln-o">{S.origination}</label>
          <input id="ln-o" type="date" value={origination} title={S.originationTitle} onChange={(e) => setOrigination(e.target.value)} />
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
      if (!v) toast(S.cleared, 2500);
      else if (r.matched) toast(S.matched(r.matched), 3000);
      else toast(S.noMatch, 4000);
      onSaved();
    } catch (e) {
      setErr(describeError(e).text);
      setBusy(false);
    }
  };

  return (
    <Drawer open title={S.payments} label={S.payments} width={520} onClose={onClose}
      tag={loan ? <Tag>{loanName(loan, withId.indexOf(loan))}</Tag> : undefined}
      footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.cancel}</button>
        <button className="btn primary" disabled={busy || !value.trim() || !loan} onClick={() => void send(value.trim())}>{busy ? S.saving : C.save}</button></>}>
      {err && <Notice tone="neg">{S.notSaved(err)}</Notice>}
      {withId.length > 1 && (
        <div className="field">
          <label htmlFor="in-loan">{S.loan}</label>
          <select id="in-loan" value={id ?? ""} onChange={(e) => pick(Number(e.target.value))}>
            {withId.map((l, i) => <option key={l.id} value={l.id}>{loanName(l, i)}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label>{S.method}</label>
        <div><Seg<Mode> label={S.method} items={[[S.byPhrase, "text"], [S.byIban, "iban"]]} value={mode} onChange={(m) => { setMode(m); setErr(null); }} /></div>
      </div>
      {mode === "text" ? (
        <>
          <div className="field">
            <label htmlFor="in-t">{S.phrase}</label>
            <div className="inline">
              {/* The placeholder is an example Polish transfer title (matching data), not UI copy. */}
              <input id="in-t" value={text} placeholder="RATA KREDYTU" maxLength={120} autoComplete="off" data-autofocus onChange={(e) => setText(e.target.value)} />
              {stored && <button className="lnk" disabled={busy} onClick={() => void send("")}>{S.clear}</button>}
            </div>
            <span className="fhint">{S.phraseHint}</span>
          </div>
          {rec.loading && !rec.data ? <Skeleton h={36} /> : candidates.length > 0 && (
            <>
              <div className="kicker" style={{ margin: "14px 0 4px" }}>{S.recent}</div>
              {candidates.map((c) => (
                <div className="row" key={`${c.payee}|${c.currency}|${c.amount}`}>
                  <div className="grow">
                    <div className="t">{c.payee}</div>
                    <div className="d">{S.candidate(cur(Math.abs(c.amount), c.currency), c.gap_days, dmShort(c.last))}</div>
                  </div>
                  <button className="lnk" onClick={() => setText(c.payee)}>{S.use}</button>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <div className="field">
          <label htmlFor="in-i">{S.ibanLabel}</label>
          {loan?.payment_iban_tail && <span className="fhint">{S.storedIban(loan.payment_iban_tail)}</span>}
          <div className="inline">
            <input id="in-i" value={iban} autoComplete="off" inputMode="numeric" placeholder={loan?.payment_iban_tail ? S.newNumber : undefined}
              onChange={(e) => setIban(e.target.value)} />
            {stored && <button className="lnk" disabled={busy} onClick={() => void send("")}>{S.clear}</button>}
          </div>
          <span className="fhint">{S.ibanHint}</span>
        </div>
      )}
    </Drawer>
  );
}
