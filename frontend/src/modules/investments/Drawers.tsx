// Drawers over the workspace (one at a time): import, manual transaction, brokerage account,
// thesis, agent proposal, signal history + decision journal, an instrument's transactions.
import { useRef, useState } from "react";
import { ApiError } from "../../core/api";
import { describeError, describeImportWarning, proposalError, proposalSummary } from "../../core/messages";
import { useAsync } from "../../hooks";
import { Drawer, Notice, RadioList, Skeleton, Stepper, Tag, useToast } from "../../ui";
import {
  type AccountRow, approveProposal, type CommitResult, getProposal, getTransactions, type ImportPreview,
  type Position, postAccount, postImportCommit, postImportPreview, postThesis, postTransaction, patchThesis, rejectProposal, type Thesis,
} from "./api";
import {
  accountLabel, dm, dmy, ENTRY_TYPE, isoDate, money, nTxns, numInput, parseNum, plural, qty, TXN_TYPE, txnType, WRAPPER,
} from "./labels";
import { commitLabel, TXN_RULES, txnCash, validateTxn } from "./logic";

/** The Polish label of the error's `X-Finanse-Error-Code` (core/messages.ts), else the server's detail. */
const errText = (e: unknown) => describeError(e).text;

/** One import warning: "wiersz N: " + the Polish label of its kind, the English detail next to it. */
function WarningText({ w }: { w: { row: number | null; kind: string; message: string; code?: string } }) {
  const d = describeImportWarning(w);
  return <>{w.row != null ? `wiersz ${w.row}: ` : ""}{d.text}{d.detail && <span className="muted" style={{ fontSize: 12 }}> ({d.detail})</span>}</>;
}

// ---- import ------------------------------------------------------------------------------

const IMPORTERS: [string, string][] = [["auto", "rozpoznaj automatycznie"], ["finanse", "format finanse"], ["generic_csv", "CSV z mapowaniem kolumn"]];
const MAPPING_HINT = `# Mapowanie kolumn CSV (przykład)\ndelimiter: ";"\ncolumns:\n  date: Data\n  type: Typ\n  symbol: Instrument\n  quantity: Ilość\n  price: Cena\n  cash_amount: Kwota\n  currency: Waluta`;

export function ImportDrawer({ slug, accounts, initialAccount, onClose, onDone, onAddAccount, onManual, onClassify }: {
  slug: string; accounts: AccountRow[]; initialAccount: number | null; onClose: () => void;
  onDone: (r: CommitResult) => void; onAddAccount: () => void; onManual: () => void; onClassify: () => void;
}) {
  const [step, setStep] = useState(initialAccount != null || accounts.length === 1 ? 1 : 0);
  const [acc, setAcc] = useState<number | null>(initialAccount ?? (accounts.length === 1 ? accounts[0].id : null));
  const account = accounts.find((a) => a.id === acc) ?? null;
  const [file, setFile] = useState<File | null>(null);
  const [importer, setImporter] = useState("auto");
  const [mapping, setMapping] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problems, setProblems] = useState(false);
  const [all, setAll] = useState(false);
  const [fixes, setFixes] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runPreview = async () => {
    if (!file || acc == null) return;
    setBusy(true); setErr(null);
    try {
      const p = await postImportPreview(slug, { file, account_id: acc, importer, mapping: importer === "generic_csv" ? mapping : null });
      setPreview(p);
      setFixes(new Set((p.reconciliation?.diffs ?? []).filter((d) => d.correction).map((d) => String(d.instrument_id))));
      setStep(2);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview || acc == null) return;
    setBusy(true); setErr(null);
    try {
      const r = await postImportCommit(slug, {
        file_id: preview.file_id, file_name: preview.file_name, account_id: acc, importer: preview.importer.id ?? importer,
        mapping: importer === "generic_csv" ? mapping : null, corrections: [...fixes],
      });
      setDone(r); setStep(3); onDone(r);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  const counts = preview?.counts;
  const skipped = preview ? preview.warnings.filter((w) => w.row != null) : [];
  const rows = preview ? preview.rows.filter((r) => !problems || r.status !== "new" || r.instrument?.new) : [];
  const shown = all ? rows : rows.slice(0, 8);
  const newOnes = preview?.new_instruments ?? [];
  const recon = preview?.reconciliation ?? null;
  const footer = step === 2 && preview ? (
    <>
      <button className="btn" onClick={() => setStep(1)}>← Wstecz</button>
      <span style={{ flex: 1 }} />
      <button className="btn primary" disabled={busy || !preview.can_commit || !counts?.new && !fixes.size} onClick={commit}>
        {busy ? "Importuję…" : commitLabel(counts?.new ?? 0, fixes.size)}
      </button>
    </>
  ) : step === 1 ? (
    <>
      {accounts.length > 1 && <button className="btn" onClick={() => setStep(0)}>← Wstecz</button>}
      <span style={{ flex: 1 }} />
      <button className="lnk" onClick={onManual}>dodaj ręcznie</button>
      <button className="btn primary" disabled={!file || busy || (importer === "generic_csv" && !mapping.trim() && !account?.has_mapping)} onClick={runPreview}>
        {busy ? "Sprawdzam…" : "Podgląd"}
      </button>
    </>
  ) : step === 0 ? (
    <><span style={{ flex: 1 }} /><button className="btn primary" disabled={acc == null} onClick={() => setStep(1)}>Dalej</button></>
  ) : (
    <><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Zamknij</button></>
  );

  return (
    <Drawer open title="Import transakcji" tag={account ? <Tag>{accountLabel(account, accounts)}</Tag> : undefined} width={600} footer={footer} onClose={onClose} label="Import transakcji">
      <Stepper steps={["Rachunek", "Plik", "Podgląd", "Gotowe"]} current={step} />
      {err && <Notice tone="neg">{err}</Notice>}
      {step === 0 && (
        <>
          {accounts.length ? (
            <RadioList<string> name="imp-acc" value={acc == null ? "" : String(acc)} onChange={(v) => setAcc(Number(v))}
              options={accounts.map((a) => ({ value: String(a.id), title: accountLabel(a, accounts), desc: `${a.name} · ${a.currency}${a.importer ? ` · importer: ${IMPORTERS.find(([k]) => k === a.importer)?.[1] ?? a.importer}` : ""}` }))} />
          ) : <div className="muted" style={{ fontSize: 13 }}>Najpierw dodaj rachunek maklerski.</div>}
          <button className="lnk" onClick={onAddAccount}>Dodaj rachunek</button>
        </>
      )}
      {step === 1 && (
        <>
          <div className="field">
            <label htmlFor="imp-file">Plik od brokera</label>
            <input id="imp-file" ref={fileRef} type="file" accept=".csv,.json,.txt,text/csv,application/json" data-autofocus
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
          </div>
          <div className="field">
            <label htmlFor="imp-importer">Importer</label>
            <select id="imp-importer" value={importer} onChange={(e) => setImporter(e.target.value)}>
              {IMPORTERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {account?.importer && <span className="hint">zapamiętany: {IMPORTERS.find(([k]) => k === account.importer)?.[1] ?? account.importer}{account.has_mapping ? " (z mapowaniem)" : ""}</span>}
          </div>
          {importer === "generic_csv" && (
            <div className="field">
              <label htmlFor="imp-map">Mapowanie (YAML){account?.has_mapping ? " · puste = zapamiętane" : ""}</label>
              <textarea id="imp-map" rows={9} value={mapping} placeholder={MAPPING_HINT} onChange={(e) => setMapping(e.target.value)}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
            </div>
          )}
        </>
      )}
      {step === 2 && preview && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            <code>{preview.file_name}</code> · importer: {IMPORTERS.find(([k]) => k === preview.importer.id)?.[1] ?? preview.importer.name ?? preview.importer.id ?? "-"}{preview.importer.requested === "auto" ? " (rozpoznany automatycznie)" : ""} · {plural(counts?.rows ?? preview.rows.length, "wiersz", "wiersze", "wierszy")} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setStep(1)}>zmień importer</button>
          </div>
          {preview.errors.length > 0 && (
            <Notice tone="neg"><b>Plik ma błędy: popraw je przed importem.</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{preview.errors.slice(0, 6).map((e, k) => <li key={k}><WarningText w={e} /></li>)}</ul>
            </Notice>
          )}
          {preview.previous_imports.length > 0 && <Notice tone="warn">Plik importowany już {dm(preview.previous_imports[0].at)}: powtórzone wiersze to duplikaty.</Notice>}
          <div className="controls" style={{ marginBottom: 8 }}>
            <Tag tone="pos" solid>{plural(counts?.new ?? 0, "nowy", "nowe", "nowych")}</Tag>
            <Tag>{plural(counts?.duplicates ?? 0, "duplikat", "duplikaty", "duplikatów")}</Tag>
            {skipped.length > 0 && <Tag tone="warn" solid>{plural(skipped.length, "pominięty", "pominięte", "pominiętych")}</Tag>}
            <span className="spacer" />
            <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" className="check" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> pokaż tylko problemy
            </label>
          </div>
          <table>
            <thead><tr><th>Data</th><th>Typ</th><th>Instrument</th><th className="num">Ilość</th><th className="num">Kwota</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.row} style={r.status === "duplicate" ? { color: "var(--muted)" } : undefined}>
                  <td>{r.date}</td><td>{txnType(r.type)}</td>
                  <td>{r.instrument ? <>{r.instrument.label} {r.instrument.new && <Tag tone="info">nowy instrument</Tag>}</> : <span className="muted">-</span>}</td>
                  <td className="num">{r.quantity != null ? qty(r.quantity) : "-"}</td>
                  <td className={`num ${r.status === "duplicate" ? "" : r.amount > 0 ? "pos" : r.amount < 0 ? "neg" : ""}`}>{money(r.amount, r.cash_currency, true)}</td>
                  <td>{r.status === "duplicate" ? <Tag>duplikat</Tag> : <Tag tone="pos">nowy</Tag>}</td>
                </tr>
              ))}
              {skipped.map((w, k) => (
                <tr key={`s${k}`}>
                  <td colSpan={4} className="muted"><WarningText w={w} /></td><td className="num">-</td>
                  <td><Tag tone="warn">pominięty</Tag> <button className="lnk" style={{ fontSize: 12 }} onClick={onManual}>dodaj ręcznie</button></td>
                </tr>
              ))}
              {!all && rows.length > shown.length && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: "center", fontSize: 12 }}>
                  … {rows.length - shown.length} kolejnych wierszy · <button className="lnk" style={{ fontSize: 12 }} onClick={() => setAll(true)}>pokaż wszystkie</button>
                </td></tr>
              )}
              {!rows.length && !skipped.length && <tr><td colSpan={6} className="muted">{problems ? "Brak problemów." : "Plik nie zawiera transakcji."}</td></tr>}
            </tbody>
          </table>

          {recon && recon.diffs.length > 0 && (
            <>
              <div className="controls" style={{ margin: "16px 0 6px" }}>
                <strong style={{ fontSize: 14 }}>Uzgodnienie</strong>
                {recon.as_of && <Tag>snapshot {preview.account.broker_name.replace(/ Broker$/, "")} z {dm(recon.as_of)}</Tag>}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 12 }}>{recon.mismatches ? plural(recon.mismatches, "różnica", "różnice", "różnic") : "zgodne"}</span>
              </div>
              <table>
                <thead><tr><th>Instrument</th><th className="num">U brokera</th><th className="num">Po imporcie</th><th className="num">Różnica</th><th title="Transakcja „korekta stanu” z zerowym kosztem; uzupełnisz ją później.">Korekta</th></tr></thead>
                <tbody>
                  {recon.diffs.map((d) => {
                    const id = String(d.instrument_id);
                    const on = fixes.has(id);
                    return (
                      <tr key={id} className={d.delta ? "warnrow" : ""}>
                        <td>{d.label}</td><td className="num">{qty(d.broker_quantity)}</td><td className="num">{qty(d.computed_quantity)}</td>
                        <td className="num" style={d.delta ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{d.delta ? `${d.delta > 0 ? "+" : ""}${qty(d.delta)}` : <span className="muted">-</span>}</td>
                        <td>{d.correction ? (
                          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, whiteSpace: "normal" }}>
                            <input type="checkbox" className="check" checked={on} onChange={(e) => setFixes((cur) => { const n = new Set(cur); if (e.target.checked) n.add(id); else n.delete(id); return n; })} />
                            {d.delta > 0 ? "dodaj" : "odejmij"} {d.delta > 0 ? "+" : ""}{qty(d.delta)} szt.{d.correction.date ? ` (korekta stanu na ${dm(d.correction.date)})` : ""}
                          </label>
                        ) : <span className="muted">-</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {newOnes.length > 0 && (
            <Notice tone="info" style={{ margin: "14px 0 0" }}>
              Do sklasyfikowania po imporcie: {newOnes.map((i) => i.symbol ?? i.label).join(", ")}.
            </Notice>
          )}
        </>
      )}
      {step === 3 && done && (
        <div className="empty" style={{ textAlign: "left", padding: "8px 0" }}>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>Zaimportowano {nTxns(done.inserted)}{done.corrections ? ` i ${plural(done.corrections, "korektę", "korekty", "korekt")}` : ""}.</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {done.duplicates ? plural(done.duplicates, "duplikat pominięty", "duplikaty pominięte", "duplikatów pominiętych") : ""}
          </div>
          <div className="controls" style={{ justifyContent: "flex-start" }}>
            {done.new_instrument_ids.length > 0 && (
              <button className="btn primary" onClick={onClassify}>Sklasyfikuj {plural(done.new_instrument_ids.length, "instrument", "instrumenty", "instrumentów")}</button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ---- manual transaction ------------------------------------------------------------------

const TYPES = ["buy", "sell", "deposit", "withdrawal", "dividend", "interest", "fee", "tax", "transfer_in", "transfer_out", "adjustment", "split"];

export function TxnDrawer({ slug, accounts, positions, preset, onClose, onSaved }: {
  slug: string; accounts: AccountRow[]; positions: Position[];
  preset: { instrumentId?: number | string | null; type?: string; accountId?: number | null } | null;
  onClose: () => void; onSaved: (warnings: string[]) => void;
}) {
  const today = isoDate(new Date());
  const presetPos = positions.find((p) => String(p.instrument.id) === String(preset?.instrumentId ?? ""));
  const [acc, setAcc] = useState<number | null>(preset?.accountId ?? presetPos?.accounts[0]?.account_id ?? accounts[0]?.id ?? null);
  const [type, setType] = useState(preset?.type ?? (presetPos ? "buy" : positions.length ? "buy" : "deposit"));
  const [date, setDate] = useState(today);
  const [instId, setInstId] = useState<string>(presetPos ? String(presetPos.instrument.id) : positions.length ? "" : "__new");
  const [symbol, setSymbol] = useState(""), [isin, setIsin] = useState(""), [name, setName] = useState("");
  const [q, setQ] = useState(""), [price, setPrice] = useState(presetPos ? numInput(presetPos.price) : ""), [amount, setAmount] = useState(""), [fee, setFee] = useState(""), [split, setSplit] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === acc) ?? null;
  const rule = TXN_RULES[type];
  const isNew = instId === "__new";
  const pos = positions.find((p) => String(p.instrument.id) === instId) ?? null;
  const accCur = account?.currency ?? "PLN";
  const known = pos?.price_currency ?? pos?.instrument.currency ?? null;
  const [curPick, setCurPick] = useState<string | null>(null);
  const currency = curPick ?? known ?? accCur;
  const [fx, setFx] = useState("");
  const cross = rule.sign !== "neutral" && currency !== accCur;
  const fxNum = parseNum(fx);
  const values = {
    type, hasInstrument: rule.instrument !== "none" && (isNew ? !!(symbol.trim() || isin.trim()) : !!instId),
    quantity: parseNum(q), price: parseNum(price), amount: parseNum(amount), fee: parseNum(fee), split: parseNum(split), date,
  };
  const errors = validateTxn(values, today);
  if (cross && !(fxNum != null && fxNum > 0)) errors.fx = `Podaj kurs: ${accCur} za 1 ${currency}.`;
  const rawCash = txnCash(values);
  const cash = rawCash == null ? null : cross ? (fxNum ? rawCash * fxNum : null) : rawCash;
  const fe = (k: string) => (touched && errors[k] ? <span className="fe">{errors[k]}</span> : null);
  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length || acc == null) return;
    setBusy(true); setErr(null);
    try {
      const r = await postTransaction(slug, {
        account_id: acc, type, trade_date: date,
        ...(rule.instrument !== "none" && instId && !isNew ? { instrument_id: pos?.instrument.id ?? instId } : {}),
        ...(rule.instrument !== "none" && isNew && (symbol.trim() || isin.trim()) ? { instrument: { symbol: symbol.trim() || null, isin: isin.trim().toUpperCase() || null, name: name.trim() || null, currency } } : {}),
        quantity: rule.quantity !== "none" ? values.quantity : null,
        price: rule.price !== "none" ? values.price : null,
        gross_amount: rule.amount !== "none" ? values.amount : null,
        fee: values.fee, split_ratio: rule.split ? values.split : null, currency, note: note.trim() || null,
        ...(cross ? { cash_currency: accCur, fx_rate: fxNum } : {}),
      });
      onSaved(r.warnings);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Drawer open title="Dodaj transakcję" tag={account ? <Tag>{accountLabel(account, accounts)}</Tag> : undefined} onClose={onClose} label="Dodaj transakcję"
      footer={<><span className="hint">{cash != null && cash !== 0 ? `Wpływ na gotówkę: ${money(cash, cross ? accCur : currency, true)}` : rule.sign === "neutral" ? "bez wpływu na gotówkę" : ""}</span><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Anuluj</button><button className="btn primary" disabled={busy || acc == null} onClick={save}>{busy ? "Zapisuję…" : "Zapisz"}</button></>}>
      {err && <Notice tone="neg">Nie zapisano: {err}</Notice>}
      <div className="form-row">
        <div className="field">
          <label htmlFor="tx-acc">Rachunek</label>
          <select id="tx-acc" value={acc ?? ""} onChange={(e) => setAcc(Number(e.target.value))} data-autofocus>
            {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, accounts)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tx-type">Typ</label>
          <select id="tx-type" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{TXN_TYPE[t]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tx-date">Data</label>
          <input id="tx-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          {fe("date")}
        </div>
      </div>
      {rule.instrument !== "none" && (
        <div className="field">
          <label htmlFor="tx-inst">Instrument{rule.instrument === "optional" ? " (opcjonalnie)" : ""}</label>
          <select id="tx-inst" value={instId} onChange={(e) => setInstId(e.target.value)}>
            <option value="">{rule.instrument === "optional" ? "bez instrumentu" : "wybierz…"}</option>
            {positions.map((p) => <option key={String(p.instrument.id)} value={String(p.instrument.id)}>{p.instrument.label}{p.instrument.symbol && p.instrument.symbol !== p.instrument.label ? ` (${p.instrument.symbol})` : ""}</option>)}
            <option value="__new">nowy instrument…</option>
          </select>
          {fe("instrument")}
        </div>
      )}
      {rule.instrument !== "none" && isNew && (
        <div className="form-row">
          <div className="field"><label htmlFor="tx-sym">Symbol</label><input id="tx-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="np. VWCE" /></div>
          <div className="field"><label htmlFor="tx-isin">ISIN (zalecany)</label><input id="tx-isin" value={isin} onChange={(e) => setIsin(e.target.value)} placeholder="IE00BK5BQT80" /></div>
          <div className="field"><label htmlFor="tx-name">Nazwa</label><input id="tx-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
      )}
      <div className="form-row">
        {rule.quantity !== "none" && <div className="field"><label htmlFor="tx-q">Ilość{rule.quantity === "optional" ? " (opcjonalnie)" : ""}</label><input id="tx-q" className="num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />{fe("quantity")}</div>}
        {rule.price !== "none" && <div className="field"><label htmlFor="tx-p" title={rule.price === "optional" ? "Pusta = koszt nieznany" : undefined}>Cena ({currency})</label><input id="tx-p" className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />{fe("price")}</div>}
        {rule.amount !== "none" && <div className="field"><label htmlFor="tx-a">Kwota ({currency})</label><input id="tx-a" className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />{fe("amount")}</div>}
        {rule.split && <div className="field"><label htmlFor="tx-s">Współczynnik (nowe na 1 starą)</label><input id="tx-s" className="num" inputMode="decimal" value={split} onChange={(e) => setSplit(e.target.value)} />{fe("split")}</div>}
        {rule.sign !== "neutral" && <div className="field"><label htmlFor="tx-f">Prowizja</label><input id="tx-f" className="num" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />{fe("fee")}</div>}
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="tx-cur">Waluta transakcji</label>
          <select id="tx-cur" value={currency} onChange={(e) => setCurPick(e.target.value)}>
            {[...new Set([currency, accCur, "PLN", "EUR", "USD", "GBP"])].map((c) => <option key={c}>{c}</option>)}
          </select>
          {known && currency !== known && <span className="fe">instrument jest notowany w {known}</span>}
        </div>
        {cross && <div className="field"><label htmlFor="tx-fx">Kurs ({accCur} za 1 {currency})</label><input id="tx-fx" className="num" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} />{fe("fx")}</div>}
      </div>
      <div className="field"><label htmlFor="tx-note">Notatka</label><input id="tx-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="foot">Kwoty bez znaku; kierunek wynika z typu.</div>
    </Drawer>
  );
}

// ---- brokerage account -------------------------------------------------------------------

const BROKERS: [string, string][] = [["xtb", "XTB"], ["dif", "DIF Broker"], ["binance", "Binance"], ["zonda", "Zonda"], ["manual", "inny (ręcznie)"]];

export function AccountDrawer({ slug, onClose, onSaved }: { slug: string; onClose: () => void; onSaved: (a: AccountRow) => void }) {
  const [broker, setBroker] = useState("xtb");
  const [wrapper, setWrapper] = useState("regular");
  const [currency, setCurrency] = useState("PLN");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const auto = `${BROKERS.find(([k]) => k === broker)?.[1].split(" ")[0]} ${WRAPPER[wrapper]}`;
  const save = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await postAccount(slug, { name: name.trim() || auto, broker, wrapper, currency })); }
    catch (e) { setErr(e instanceof ApiError && e.status === 409 ? "Rachunek o tej nazwie u tego brokera już istnieje." : errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open title="Dodaj rachunek maklerski" onClose={onClose} label="Dodaj rachunek"
      footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Anuluj</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? "Zapisuję…" : "Dodaj"}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="form-row">
        <div className="field"><label htmlFor="ac-b">Broker</label><select id="ac-b" value={broker} onChange={(e) => setBroker(e.target.value)} data-autofocus>{BROKERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="ac-w">Opakowanie</label><select id="ac-w" value={wrapper} onChange={(e) => setWrapper(e.target.value)}>{Object.entries(WRAPPER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="ac-c">Waluta</label><select id="ac-c" value={currency} onChange={(e) => setCurrency(e.target.value)}>{["PLN", "EUR", "USD", "GBP", "CHF"].map((c) => <option key={c}>{c}</option>)}</select></div>
      </div>
      <div className="field"><label htmlFor="ac-n">Nazwa</label><input id="ac-n" value={name} placeholder={auto} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
    </Drawer>
  );
}

// ---- thesis ------------------------------------------------------------------------------

export function ThesisDrawer({ slug, position, thesis, onClose, onSaved }: {
  slug: string; position: Position; thesis: Thesis | null; onClose: () => void; onSaved: () => void;
}) {
  const [entry, setEntry] = useState(thesis?.entry_type ?? "sentiment_correction");
  const [text, setText] = useState(thesis?.thesis ?? "");
  const [inv, setInv] = useState(thesis?.invalidation ?? "");
  const [exit, setExit] = useState(thesis?.exit_plan ?? "");
  const [size, setSize] = useState(thesis?.size_plan ?? "");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { entry_type: entry, thesis: text.trim() || null, invalidation: inv.trim() || null, exit_plan: exit.trim() || null, size_plan: size.trim() || null };
    try {
      if (thesis) await patchThesis(slug, thesis.id, { ...body, reviewed });
      else await postThesis(slug, position.instrument.id, body);
      onSaved();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Drawer open title={thesis ? "Edytuj tezę" : "Dodaj tezę"} tag={<Tag>{position.instrument.label}</Tag>} onClose={onClose} label="Teza"
      footer={<>{thesis && <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" className="check" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> przejrzana dziś</label>}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Anuluj</button><button className="btn primary" disabled={busy || !text.trim()} onClick={save}>{busy ? "Zapisuję…" : "Zapisz"}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="field"><label htmlFor="th-e">Typ wejścia</label>
        <select id="th-e" value={entry} onChange={(e) => setEntry(e.target.value)} data-autofocus>{Object.entries(ENTRY_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <div className="field"><label htmlFor="th-t">Wejście</label><textarea id="th-t" rows={3} placeholder="Dlaczego ta pozycja?" value={text} onChange={(e) => setText(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-i">Unieważnienie</label><textarea id="th-i" rows={2} placeholder="Co by znaczyło, że się mylę?" value={inv} onChange={(e) => setInv(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-x">Plan wyjścia</label><textarea id="th-x" rows={2} value={exit} onChange={(e) => setExit(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-s">Wielkość i dokupienia</label><textarea id="th-s" rows={2} value={size} onChange={(e) => setSize(e.target.value)} /></div>
    </Drawer>
  );
}

// ---- agent proposal ----------------------------------------------------------------------

export function ProposalDrawer({ slug, id, version, onClose, onDone, onChanged }: {
  slug: string; id: number; version: number | null; onClose: () => void; onDone: (approved: boolean, newVersion: number | null) => void;
  onChanged?: () => void;
}) {
  const p = useAsync(() => getProposal(slug, id), [slug, id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const data = p.data;
  const act = async (approve: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = approve ? await approveProposal(slug, id) : await rejectProposal(slug, id);
      const v = r.result && typeof r.result.version === "number" ? (r.result.version as number) : null;
      onDone(approve, v);
    } catch (e) {
      setErr(errText(e));
      p.reload(); // a refused approval marks the proposal failed: show its new status
      onChanged?.();
    } finally { setBusy(false); }
  };
  const isImport = data?.kind === "import";
  const failure = proposalError(data?.result); // why applying failed (stable error_code -> Polish)
  const kindLabel = !data ? "" : isImport ? "import" : data.kind === "strategy" ? "strategia" : "reguła";
  const yamlDiff = typeof data?.diff === "string" ? data.diff : data?.diff?.yaml ?? null;
  const mdDiff = typeof data?.diff === "object" && data?.diff ? data.diff.md ?? null : null;
  const bt = data?.backtest;
  const pv = data?.preview;
  const unsupported = !!data?.converter_unsupported; // stored before the app stopped running scripts
  return (
    <Drawer open title="Propozycja agenta" tag={data ? <Tag tone="info">{kindLabel}</Tag> : undefined}
      width={600} onClose={onClose} label="Propozycja agenta"
      footer={data?.status === "pending" ? <>
        <button className="btn" disabled={busy} onClick={() => act(false)}>Odrzuć</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || unsupported} onClick={() => act(true)}>{isImport ? "Zatwierdź import" : `Zatwierdź jako v${(version ?? 0) + 1}`}</button>
      </> : undefined}>
      {err && <Notice tone="neg">{failure ? <span title={failure.detail ?? undefined}>{failure.text}</span> : err}</Notice>}
      {!err && data?.status === "failed" && failure && <Notice tone="neg"><span title={failure.detail ?? undefined}>{failure.text}</span></Notice>}
      {p.error && <Notice tone="neg">Nie udało się wczytać propozycji: {p.error}</Notice>}
      {!data && !p.error && <Skeleton h={160} />}
      {data && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{proposalSummary(data) ?? "Propozycja zmiany"}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {data.created_at ? `zgłoszona ${dmy(data.created_at)}` : ""}
            {data.status !== "pending" ? ` · ${({ approved: "zatwierdzona", rejected: "odrzucona", failed: "nie udało się zastosować" } as Record<string, string>)[data.status] ?? data.status}` : ""}
          </div>
          {data.detail_error && !unsupported && <Notice tone="warn">{data.detail_error}</Notice>}
          {unsupported && <Notice tone="warn">Aplikacja nie uruchamia skryptów konwertera: poproś agenta o gotowy plik w formacie finanse.</Notice>}
          {data.base_changed && <Notice tone="warn">Pliki strategii zmieniły się od propozycji: poproś agenta o nową.</Notice>}
          {data.reason && <div className="thesis" style={{ marginBottom: 12 }}><b>Uzasadnienie agenta:</b> {data.reason}</div>}
          {yamlDiff && <DiffBlock title="Zmiana w strategy.yaml" text={yamlDiff} />}
          {mdDiff && <DiffBlock title="Zmiana w strategy.md" text={mdDiff} />}
          {!yamlDiff && data.rule_yaml && <DiffBlock title="Nowa reguła" text={data.rule_yaml} />}
          {bt && (
            <Notice tone="info" style={{ margin: "12px 0 0" }}>
              {bt.evaluated
                ? <>Test wsteczny {bt.from ? dm(bt.from) : ""}{bt.to ? ` - ${dm(bt.to)}` : ""}: reguła zadziałałaby w {bt.points_fired ?? 0} z {bt.evaluated} punktów ({plural(bt.episodes ?? 0, "epizod", "epizody", "epizodów")}){bt.last_fired ? `, ostatnio ${dm(bt.last_fired)}` : ""}{bt.instruments?.length ? ` · ${bt.instruments.join(", ")}` : ""}.</>
                : "Test wsteczny: brak historii transakcji."}
            </Notice>
          )}
          {isImport && (
            <>
              <div className="kv" style={{ margin: "4px 0 10px" }}>
                <span className="k">Plik</span><span className="v"><code>{data.file_name ?? "-"}</code></span>
                <span className="k">Rachunek</span><span className="v">{data.account ?? "-"}</span>
                {pv && <><span className="k">Podgląd</span><span className="v">{plural(Number(pv.new ?? 0), "nowy wiersz", "nowe wiersze", "nowych wierszy")} · {plural(Number(pv.duplicates ?? 0), "duplikat", "duplikaty", "duplikatów")}{Number(pv.reconciliation_mismatches ?? 0) ? ` · ${plural(Number(pv.reconciliation_mismatches), "różnica", "różnice", "różnic")} ze snapshotem` : ""}{Number(pv.errors ?? 0) ? ` · ${plural(Number(pv.errors), "błąd", "błędy", "błędów")}` : ""}</span></>}
              </div>
            </>
          )}
          <div className="foot">Odrzucenie niczego nie zmienia.</div>
        </>
      )}
    </Drawer>
  );
}

function DiffBlock({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h4 style={{ margin: "10px 0 6px", fontSize: 12, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.03em" }}>{title}</h4>
      <div className="diff" role="region" aria-label={title}>
        {text.split("\n").map((l, k) => (
          <div key={k} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l || " "}</div>
        ))}
      </div>
    </>
  );
}

// ---- an instrument's transactions ----------------------------------------------------------

export function TxnsDrawer({ slug, position, accounts, onClose, onAdd }: {
  slug: string; position: Position; accounts: AccountRow[]; onClose: () => void; onAdd: () => void;
}) {
  const t = useAsync(() => getTransactions(slug, position.instrument.id), [slug, position.instrument.id]);
  const src: Record<string, string> = { import: "import", manual: "ręcznie", reconciliation: "korekta" };
  return (
    <Drawer open title="Transakcje" tag={<Tag>{position.instrument.label}</Tag>} width={640} onClose={onClose} label="Transakcje instrumentu"
      footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onAdd}>Dodaj transakcję</button></>}>
      {t.error && <Notice tone="neg">{t.error}</Notice>}
      {!t.data && !t.error ? <Skeleton h={120} /> : (
        <table>
          <thead><tr><th>Data</th><th>Rachunek</th><th>Typ</th><th className="num">Ilość</th><th className="num">Cena</th><th className="num">Gotówka</th><th>Źródło</th></tr></thead>
          <tbody>
            {(t.data ?? []).map((x) => {
              const acc = accounts.find((a) => a.id === x.account_id);
              return (
                <tr key={String(x.id)}>
                  <td>{x.trade_date}</td><td>{acc ? accountLabel(acc, accounts) : x.account_name ?? "-"}</td><td>{txnType(x.type)}</td>
                  <td className="num">{x.quantity != null ? qty(x.quantity) : "-"}</td><td className="num">{x.price != null ? money(x.price, x.currency) : "-"}</td>
                  <td className={`num ${x.cash_amount > 0 ? "pos" : x.cash_amount < 0 ? "neg" : ""}`}>{money(x.cash_amount, x.cash_currency, true)}</td>
                  <td className="muted">{src[x.source] ?? x.source}</td>
                </tr>
              );
            })}
            {t.data && !t.data.length && <tr><td colSpan={7} className="muted">Brak transakcji.</td></tr>}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
