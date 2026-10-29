// Drawers over the workspace (one at a time): import, manual transaction, brokerage account,
// thesis, agent proposal, signal history + decision journal, an instrument's transactions.
import { useRef, useState } from "react";
import { ApiError } from "../../core/api";
import { acceptOf, importerName, statusOf } from "../../core/connectors";
import { getBindings, getConnectors } from "../../core/connectorsApi";
import { type RunFailure, RunError, runFailureOf } from "../../core/RunError";
import { describeError, describeImportWarning, proposalError, proposalSummary } from "../../core/messages";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { Drawer, Notice, RadioList, Skeleton, Stepper, Tag, useToast } from "../../ui";
import {
  type AccountRow, type CommitResult, getTransactions, type ImportPreview,
  type Position, postAccount, postImportCommit, postImportPreview, postThesis, postTransaction, patchThesis, type Thesis,
} from "./api";
import {
  accountLabel, dm, ENTRY_TYPE, isoDate, money, nTxns, numInput, parseNum, qty, TXN_TYPE, txnType, WRAPPER,
} from "./labels";
import { C } from "../../common.strings.ts";
import { S } from "./Drawers.strings.ts";
import { commitLabel, TXN_RULES, txnCash, validateTxn } from "./logic";
import { invKey } from "./v2/api";

/** The label of the error's `X-Cashu-Error-Code` (core/messages.ts), else the server's detail. */
const errText = (e: unknown) => describeError(e).text;

/** One import warning: "wiersz N: " + the label of its kind, the English detail next to it. */
function WarningText({ w }: { w: { row: number | null; kind: string; message: string; code?: string } }) {
  const d = describeImportWarning(w);
  return <>{w.row != null ? S.row(w.row) : ""}{d.text}{d.detail && <span className="muted" style={{ fontSize: 12 }}> ({d.detail})</span>}</>;
}

// ---- import ------------------------------------------------------------------------------

/** Built-in importers: [id, label] (labels in the current language). */
export const importers = (): [string, string][] => [["auto", S.impAuto], ["cashu", S.impCashu], ["generic_csv", S.impGeneric]];

export function ImportDrawer({ slug, accounts, initialAccount, onClose, onDone, onAddAccount, onManual, onClassify }: {
  slug: string; accounts: AccountRow[]; initialAccount: number | null; onClose: () => void;
  onDone: (r: CommitResult) => void; onAddAccount: () => void; onManual: () => void; onClassify: () => void;
}) {
  const [step, setStep] = useState(initialAccount != null || accounts.length === 1 ? 1 : 0);
  const [acc, setAcc] = useState<number | null>(initialAccount ?? (accounts.length === 1 ? accounts[0].id : null));
  const account = accounts.find((a) => a.id === acc) ?? null;
  const [file, setFile] = useState<File | null>(null);
  // Approved file connectors of the module join the importer select (design/v3/connectors 5.2).
  const conn = useAsync(() => getConnectors().catch(() => []), [], { key: ck(slug, "connectors") });
  const invConnectors = (conn.data ?? []).filter((c) => c.module === "investments" && c.kind === "file");
  const approvedConn = invConnectors.filter((c) => c.status === "approved");
  const bindings = useAsync(() => getBindings(slug).catch(() => []), [slug]);
  const boundTo = (accountId: number) => (bindings.data ?? []).find((b) => b.account_id === accountId && b.module === "investments");
  const nameOf = (id: string | null | undefined) => importerName(id, invConnectors, importers());
  /** The remembered importer, or `auto` when it names a connector that is no longer approved. */
  const remembered = (a: AccountRow | null) => {
    const id = a?.importer;
    if (!id?.startsWith("connector:")) return id ?? null;
    return conn.data && !approvedConn.some((c) => `connector:${c.id}` === id) ? null : id;
  };
  const [importer, setImporter] = useState("auto");
  const [runErr, setRunErr] = useState<RunFailure | null>(null);
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
      setRunErr(null);
      const p = await postImportPreview(slug, { file, account_id: acc, importer, mapping: importer === "generic_csv" ? mapping : null });
      setPreview(p);
      setFixes(new Set((p.reconciliation?.diffs ?? []).filter((d) => d.correction).map((d) => String(d.instrument_id))));
      setStep(2);
    } catch (e) {
      const run = runFailureOf(e);
      if (run) setRunErr(run); else setErr(errText(e));
    } finally { setBusy(false); }
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
      <button className="btn" onClick={() => setStep(1)}>{S.back}</button>
      <span style={{ flex: 1 }} />
      <button className="btn primary" disabled={busy || !preview.can_commit || !counts?.new && !fixes.size} onClick={commit}>
        {busy ? S.importing : commitLabel(counts?.new ?? 0, fixes.size)}
      </button>
    </>
  ) : step === 1 ? (
    <>
      {accounts.length > 1 && <button className="btn" onClick={() => setStep(0)}>{S.back}</button>}
      <span style={{ flex: 1 }} />
      <button className="lnk" onClick={onManual}>{S.addManually}</button>
      <button className="btn primary" disabled={!file || busy || (importer === "generic_csv" && !mapping.trim() && !account?.has_mapping)} onClick={runPreview}>
        {busy ? (importer.startsWith("connector:") ? S.runningConnector : S.checking) : S.preview}
      </button>
    </>
  ) : step === 0 ? (
    <><span style={{ flex: 1 }} /><button className="btn primary" disabled={acc == null} onClick={() => setStep(1)}>{C.next}</button></>
  ) : (
    <><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.close}</button></>
  );

  return (
    <Drawer open title={S.importTitle} tag={account ? <Tag>{accountLabel(account, accounts)}</Tag> : undefined} width={600} footer={footer} onClose={onClose} label={S.importTitle}>
      <Stepper steps={[S.stepAccount, S.stepFile, S.stepPreview, S.stepDone]} current={step} />
      {err && <Notice tone="neg">{err}</Notice>}
      {runErr && step === 1 && <RunError {...runErr} />}
      {step === 0 && (
        <>
          {accounts.length ? (
            <RadioList<string> name="imp-acc" value={acc == null ? "" : String(acc)} onChange={(v) => setAcc(Number(v))}
              options={accounts.map((a) => ({ value: String(a.id), title: accountLabel(a, accounts), desc: S.accountDesc(a.name, a.currency, a.importer ? nameOf(a.importer) : null, boundTo(a.id)?.connector_name ?? null) }))} />
          ) : <div className="muted" style={{ fontSize: 13 }}>{S.addAccountFirst}</div>}
          <button className="lnk" onClick={onAddAccount}>{S.addAccount}</button>
        </>
      )}
      {step === 1 && (
        <>
          <div className="field">
            <label htmlFor="imp-file">{S.brokerFile}</label>
            <input id="imp-file" ref={fileRef} type="file" accept={[".csv,.json,.txt,text/csv,application/json",
              acceptOf(importer.startsWith("connector:") ? approvedConn.find((c) => `connector:${c.id}` === importer)?.extensions : importer === "auto" ? approvedConn.flatMap((c) => c.extensions ?? []) : [])].filter(Boolean).join(",")} data-autofocus
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setRunErr(null); }} />
          </div>
          <div className="field">
            <label htmlFor="imp-importer">{S.importer}</label>
            <select id="imp-importer" value={importer} onChange={(e) => { setImporter(e.target.value); setRunErr(null); }}>
              {importers().map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              {invConnectors.length > 0 && (
                <optgroup label={S.connectors}>
                  {invConnectors.map((c) => (
                    <option key={c.id} value={`connector:${c.id}`} disabled={c.status !== "approved"}>
                      {c.name}{c.status !== "approved" ? ` · ${statusOf(c.status)[0]}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {account?.importer && (
              <span className="fhint">{S.remembered(nameOf(account.importer))}{account.importer.startsWith("connector:") && conn.data && remembered(account) == null ? S.notApproved : ""}{account.has_mapping ? S.withMapping : ""}</span>
            )}
          </div>
          {importer === "generic_csv" && (
            <div className="field">
              <label htmlFor="imp-map">{S.mappingLabel}{account?.has_mapping ? S.emptyRemembered : ""}</label>
              <textarea id="imp-map" rows={9} value={mapping} placeholder={S.mappingHint} onChange={(e) => setMapping(e.target.value)}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
            </div>
          )}
        </>
      )}
      {step === 2 && preview && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            <code>{preview.file_name}</code> · {S.importerIs} {preview.importer.id?.startsWith("connector:") ? preview.importer.name ?? nameOf(preview.importer.id) : importers().find(([k]) => k === preview.importer.id)?.[1] ?? preview.importer.name ?? preview.importer.id ?? "-"}{preview.importer.requested === "auto" ? (preview.importer.id?.startsWith("connector:") ? S.detected(preview.importer.name ?? nameOf(preview.importer.id)) : S.autoDetected) : ""} · {S.nRows(counts?.rows ?? preview.rows.length)} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setStep(1)}>{S.changeImporter}</button>
          </div>
          {preview.errors.length > 0 && (
            <Notice tone="neg"><b>{S.fileErrors}</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{preview.errors.slice(0, 6).map((e, k) => <li key={k}><WarningText w={e} /></li>)}</ul>
            </Notice>
          )}
          {preview.previous_imports.length > 0 && <Notice tone="warn">{S.importedBefore(dm(preview.previous_imports[0].at))}</Notice>}
          <div className="controls" style={{ marginBottom: 8 }}>
            <Tag tone="pos" solid>{S.nNew(counts?.new ?? 0)}</Tag>
            <Tag>{S.nDuplicates(counts?.duplicates ?? 0)}</Tag>
            {skipped.length > 0 && <Tag tone="warn" solid>{S.nSkipped(skipped.length)}</Tag>}
            <span className="spacer" />
            <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" className="check" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> {S.onlyProblems}
            </label>
          </div>
          <table>
            <thead><tr><th>{S.colDate}</th><th>{S.colType}</th><th>{S.colInstrument}</th><th className="num">{S.colQty}</th><th className="num">{S.colAmount}</th><th>{S.colStatus}</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.row} style={r.status === "duplicate" ? { color: "var(--muted)" } : undefined}>
                  <td>{r.date}</td><td>{txnType(r.type)}</td>
                  <td>{r.instrument ? <>{r.instrument.label} {r.instrument.new && <Tag tone="info">{S.newInstrument}</Tag>}</> : <span className="muted">-</span>}</td>
                  <td className="num">{r.quantity != null ? qty(r.quantity) : "-"}</td>
                  <td className={`num ${r.status === "duplicate" ? "" : r.amount > 0 ? "pos" : r.amount < 0 ? "neg" : ""}`}>{money(r.amount, r.cash_currency, true)}</td>
                  <td>{r.status === "duplicate" ? <Tag>{S.duplicate}</Tag> : <Tag tone="pos">{S.new}</Tag>}</td>
                </tr>
              ))}
              {skipped.map((w, k) => (
                <tr key={`s${k}`}>
                  <td colSpan={4} className="muted"><WarningText w={w} /></td><td className="num">-</td>
                  <td><Tag tone="warn">{S.skipped}</Tag> <button className="lnk" style={{ fontSize: 12 }} onClick={onManual}>{S.addManually}</button></td>
                </tr>
              ))}
              {!all && rows.length > shown.length && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: "center", fontSize: 12 }}>
                  {S.moreRows(rows.length - shown.length)}<button className="lnk" style={{ fontSize: 12 }} onClick={() => setAll(true)}>{S.showAll}</button>
                </td></tr>
              )}
              {!rows.length && !skipped.length && <tr><td colSpan={6} className="muted">{problems ? S.noProblems : S.noTxnsInFile}</td></tr>}
            </tbody>
          </table>

          {recon && recon.diffs.length > 0 && (
            <>
              <div className="controls" style={{ margin: "16px 0 6px" }}>
                <strong style={{ fontSize: 14 }}>{S.reconciliation}</strong>
                {recon.as_of && <Tag>{S.snapshotFrom(preview.account.broker_name.replace(/ Broker$/, ""), dm(recon.as_of))}</Tag>}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 12 }}>{recon.mismatches ? S.nDiffs(recon.mismatches) : S.matching}</span>
              </div>
              <table>
                <thead><tr><th>{S.colInstrument}</th><th className="num">{S.colAtBroker}</th><th className="num">{S.colAfterImport}</th><th className="num">{S.colDiff}</th><th title={S.correctionTitle}>{S.colCorrection}</th></tr></thead>
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
                            {S.correction(d.delta > 0, `${d.delta > 0 ? "+" : ""}${qty(d.delta)}`, d.correction.date ? dm(d.correction.date) : null)}
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
              {S.toClassifyAfter(newOnes.map((i) => i.symbol ?? i.label).join(", "))}
            </Notice>
          )}
        </>
      )}
      {step === 3 && done && (
        <div className="empty" style={{ textAlign: "left", padding: "8px 0" }}>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>{S.imported(nTxns(done.inserted), done.corrections)}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {done.duplicates ? S.dupSkipped(done.duplicates) : ""}
          </div>
          <div className="controls" style={{ justifyContent: "flex-start" }}>
            {done.new_instrument_ids.length > 0 && (
              <button className="btn primary" onClick={onClassify}>{S.classify(done.new_instrument_ids.length)}</button>
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
  if (cross && !(fxNum != null && fxNum > 0)) errors.fx = S.fxRequired(accCur, currency);
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
    <Drawer open title={S.addTxn} tag={account ? <Tag>{accountLabel(account, accounts)}</Tag> : undefined} onClose={onClose} label={S.addTxn}
      footer={<><span className="fhint">{cash != null && cash !== 0 ? S.cashEffect(money(cash, cross ? accCur : currency, true)) : rule.sign === "neutral" ? S.noCashEffect : ""}</span><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.cancel}</button><button className="btn primary" disabled={busy || acc == null} onClick={save}>{busy ? S.saving : C.save}</button></>}>
      {err && <Notice tone="neg">{S.notSaved(err)}</Notice>}
      <div className="form-row">
        <div className="field">
          <label htmlFor="tx-acc">{S.account}</label>
          <select id="tx-acc" value={acc ?? ""} onChange={(e) => setAcc(Number(e.target.value))} data-autofocus>
            {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, accounts)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tx-type">{S.colType}</label>
          <select id="tx-type" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{TXN_TYPE[t]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tx-date">{S.colDate}</label>
          <input id="tx-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          {fe("date")}
        </div>
      </div>
      {rule.instrument !== "none" && (
        <div className="field">
          <label htmlFor="tx-inst">{S.colInstrument}{rule.instrument === "optional" ? S.optional : ""}</label>
          <select id="tx-inst" value={instId} onChange={(e) => setInstId(e.target.value)}>
            <option value="">{rule.instrument === "optional" ? S.noInstrument : S.choose}</option>
            {positions.map((p) => <option key={String(p.instrument.id)} value={String(p.instrument.id)}>{p.instrument.label}{p.instrument.symbol && p.instrument.symbol !== p.instrument.label ? ` (${p.instrument.symbol})` : ""}</option>)}
            <option value="__new">{S.newInstrumentOpt}</option>
          </select>
          {fe("instrument")}
        </div>
      )}
      {rule.instrument !== "none" && isNew && (
        <div className="form-row">
          <div className="field"><label htmlFor="tx-sym">{S.symbol}</label><input id="tx-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={S.symbolPlaceholder} /></div>
          <div className="field"><label htmlFor="tx-isin">{S.isin}</label><input id="tx-isin" value={isin} onChange={(e) => setIsin(e.target.value)} placeholder="IE00BK5BQT80" /></div>
          <div className="field"><label htmlFor="tx-name">{S.name}</label><input id="tx-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
      )}
      <div className="form-row">
        {rule.quantity !== "none" && <div className="field"><label htmlFor="tx-q">{S.colQty}{rule.quantity === "optional" ? S.optional : ""}</label><input id="tx-q" className="num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />{fe("quantity")}</div>}
        {rule.price !== "none" && <div className="field"><label htmlFor="tx-p" title={rule.price === "optional" ? S.emptyUnknownCost : undefined}>{S.price(currency)}</label><input id="tx-p" className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />{fe("price")}</div>}
        {rule.amount !== "none" && <div className="field"><label htmlFor="tx-a">{S.amount(currency)}</label><input id="tx-a" className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />{fe("amount")}</div>}
        {rule.split && <div className="field"><label htmlFor="tx-s">{S.splitRatio}</label><input id="tx-s" className="num" inputMode="decimal" value={split} onChange={(e) => setSplit(e.target.value)} />{fe("split")}</div>}
        {rule.sign !== "neutral" && <div className="field"><label htmlFor="tx-f">{S.fee}</label><input id="tx-f" className="num" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />{fe("fee")}</div>}
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="tx-cur">{S.txnCurrency}</label>
          <select id="tx-cur" value={currency} onChange={(e) => setCurPick(e.target.value)}>
            {[...new Set([currency, accCur, "PLN", "EUR", "USD", "GBP"])].map((c) => <option key={c}>{c}</option>)}
          </select>
          {known && currency !== known && <span className="fe">{S.quotedIn(known)}</span>}
        </div>
        {cross && <div className="field"><label htmlFor="tx-fx">{S.rate(accCur, currency)}</label><input id="tx-fx" className="num" inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} />{fe("fx")}</div>}
      </div>
      <div className="field"><label htmlFor="tx-note">{S.note}</label><input id="tx-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="foot">{S.unsignedFoot}</div>
    </Drawer>
  );
}

// ---- brokerage account -------------------------------------------------------------------

const brokers = (): [string, string][] => [["xtb", "XTB"], ["dif", "DIF Broker"], ["binance", "Binance"], ["zonda", "Zonda"], ["manual", S.otherManual]];

export function AccountDrawer({ slug, onClose, onSaved }: { slug: string; onClose: () => void; onSaved: (a: AccountRow) => void }) {
  const [broker, setBroker] = useState("xtb");
  const [wrapper, setWrapper] = useState("regular");
  const [currency, setCurrency] = useState("PLN");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const auto = `${brokers().find(([k]) => k === broker)?.[1].split(" ")[0]} ${WRAPPER[wrapper]}`;
  const save = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await postAccount(slug, { name: name.trim() || auto, broker, wrapper, currency })); }
    catch (e) { setErr(e instanceof ApiError && e.status === 409 ? S.accountExists : errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open title={S.addBrokerage} onClose={onClose} label={S.addAccount}
      footer={<><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.cancel}</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? S.saving : C.add}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="form-row">
        <div className="field"><label htmlFor="ac-b">{S.broker}</label><select id="ac-b" value={broker} onChange={(e) => setBroker(e.target.value)} data-autofocus>{brokers().map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="ac-w">{S.wrapper}</label><select id="ac-w" value={wrapper} onChange={(e) => setWrapper(e.target.value)}>{Object.entries(WRAPPER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="ac-c">{S.currency}</label><select id="ac-c" value={currency} onChange={(e) => setCurrency(e.target.value)}>{["PLN", "EUR", "USD", "GBP", "CHF"].map((c) => <option key={c}>{c}</option>)}</select></div>
      </div>
      <div className="field"><label htmlFor="ac-n">{S.name}</label><input id="ac-n" value={name} placeholder={auto} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
    </Drawer>
  );
}

// ---- thesis ------------------------------------------------------------------------------

/** Thesis of a held or watched instrument: a new one, or an edit of the latest. */
export function ThesisDrawer({ slug, instrumentId, label, thesis, onClose, onSaved }: {
  slug: string; instrumentId: number; label: string; thesis: Thesis | null; onClose: () => void; onSaved: () => void;
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
      else await postThesis(slug, instrumentId, body);
      onSaved();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Drawer open title={thesis ? S.editThesis : S.addThesis} tag={<Tag>{label}</Tag>} onClose={onClose} label={S.thesis}
      footer={<>{thesis && <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" className="check" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> {S.reviewedToday}</label>}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>{C.cancel}</button><button className="btn primary" disabled={busy || !text.trim()} onClick={save}>{busy ? S.saving : C.save}</button></>}>
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="field"><label htmlFor="th-e">{S.entryType}</label>
        <select id="th-e" value={entry} onChange={(e) => setEntry(e.target.value)} data-autofocus>{Object.entries(ENTRY_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <div className="field"><label htmlFor="th-t">{S.entry}</label><textarea id="th-t" rows={3} placeholder={S.entryPlaceholder} value={text} onChange={(e) => setText(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-i">{S.invalidation}</label><textarea id="th-i" rows={2} placeholder={S.invalidationPlaceholder} value={inv} onChange={(e) => setInv(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-x">{S.exitPlan}</label><textarea id="th-x" rows={2} value={exit} onChange={(e) => setExit(e.target.value)} /></div>
      <div className="field"><label htmlFor="th-s">{S.sizePlan}</label><textarea id="th-s" rows={2} value={size} onChange={(e) => setSize(e.target.value)} /></div>
    </Drawer>
  );
}

// ---- agent proposal: moved to core (core/ProposalDrawer.tsx; a budget sync proposal uses it too) ----------

export { ProposalDrawer } from "../../core/ProposalDrawer";

// ---- an instrument's transactions ----------------------------------------------------------

export function TxnsDrawer({ slug, position, accounts, onClose, onAdd }: {
  slug: string; position: Position; accounts: AccountRow[]; onClose: () => void; onAdd: () => void;
}) {
  // Keyed (F7 PX4): a reopened list shows at once; a transaction write reloads the home, which forgets it.
  const t = useAsync(() => getTransactions(slug, position.instrument.id), [slug, position.instrument.id],
    { key: invKey(slug, "transactions", position.instrument.id) });
  const src: Record<string, string> = { import: S.srcImport, manual: S.srcManual, reconciliation: S.srcReconciliation };
  return (
    <Drawer open title={S.txns} tag={<Tag>{position.instrument.label}</Tag>} width={640} onClose={onClose} label={S.txnsLabel}
      footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onAdd}>{S.addTxn}</button></>}>
      {t.error && <Notice tone="neg">{t.error}</Notice>}
      {!t.data && !t.error ? <Skeleton h={120} /> : (
        <table>
          <thead><tr><th>{S.colDate}</th><th>{S.account}</th><th>{S.colType}</th><th className="num">{S.colQty}</th><th className="num">{S.colPrice}</th><th className="num">{S.colCash}</th><th>{S.colSource}</th></tr></thead>
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
            {t.data && !t.data.length && <tr><td colSpan={7} className="muted">{S.noTxns}</td></tr>}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
