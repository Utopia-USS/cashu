// Statement import in the app (design/v3/first-steps section 4): Źródło (bank file, Open Banking, the connector
// slot) -> Plik (file, bank, account type, name) -> Podgląd (new / duplicates, the account it lands in) -> Gotowe.
// Nothing is written before `Importuj`; the staged file stays on this computer. Opened from the budget first steps
// (step 0) or from the tabbar `Import` (step 1, the bank file).
import { useRef, useState } from "react";
import { ApiError, getSetup } from "../../core/api";
import { acceptOf, budgetConnectorSources } from "../../core/connectors";
import { getBindings, getConnectors } from "../../core/connectorsApi";
import { type RunFailure, RunError, runFailureOf } from "../../core/RunError";
import { useShell } from "../../core/context";
import { describeError, describeImportWarning, label } from "../../core/messages";
import { cur, plural } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { Code, Drawer, Notice, RadioList, Stepper, Tag } from "../../ui";
import { getImporters, postStatementCommit, postStatementPreview, type StatementCommit, type StatementPreview } from "./api";
import { builtinSources, connectorSources, isFileSource } from "./importSources";
import { bankName, bankOptions, cliPrefix, dmShort, importDoneLine, previewRows, STATEMENT_TYPES, statementErrorKey } from "./logic";

const signed = (v: number, c: string) => (v > 0.004 ? `+${cur(v, c)}` : cur(v, c));

export function StatementImportDrawer({ slug, initialStep = 0, fromTab, onClose, onDone }: {
  slug: string;
  /** 0 = Źródło (first steps), 1 = Plik with the bank file (tabbar `Import`). */
  initialStep?: 0 | 1;
  /** Opened from the tabbar on a budget tab: `Gotowe` offers `Zamknij` instead of `Wydatki →`. */
  fromTab?: boolean;
  onClose: () => void;
  /** At commit (the drawer stays open on `Gotowe`). */
  onDone: (r: StatementCommit) => void;
}) {
  const { system, go } = useShell();
  const ebConfigured = !!system?.secrets?.enable_banking_key;
  const setup = useAsync(() => getSetup(slug, "budget"), [slug], { key: ck(slug, "setup", "budget") });
  // The `Bank` select comes from the server's importer list; an older server without it: the fallback list.
  const importers = useAsync(() => getImporters(slug).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }), [slug], { key: ck(slug, "budget", "importers") });
  const choices = importers.data?.importers ?? null;
  // Connector radios: the importer list says which can run, the status list shows the ones waiting for approval.
  const connectors = useAsync(() => getConnectors().catch(() => []), [], { key: ck(slug, "connectors") });
  const bindings = useAsync(() => getBindings(slug).catch(() => []), [slug]);
  const connectorItems = budgetConnectorSources(choices, connectors.data);
  const maxBytes = importers.data?.max_bytes ?? null;
  const [step, setStep] = useState<number>(initialStep);
  const [source, setSource] = useState("csv");
  const [file, setFile] = useState<File | null>(null);
  const [bank, setBank] = useState("auto");
  const [accountType, setAccountType] = useState("checking");
  const [accountName, setAccountName] = useState("");
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // the server's English detail under `err` (a cashu-format file: which rows / fields failed)
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<RunFailure | null>(null);
  const [done, setDone] = useState<StatementCommit | null>(null);
  const bankRef = useRef<HTMLSelectElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sources = [...builtinSources(ebConfigured), ...connectorSources(connectorItems)];
  // A connector's file is read by that connector (no bank choice).
  const fileBank = source.startsWith("connector:") ? source : bank;
  const connector = connectorItems.find((c) => c.value === source) ?? null;

  const clearErr = () => { setErr(null); setErrDetail(null); setRunErr(null); };
  const fail = (e: unknown) => {
    const run = runFailureOf(e);
    if (run) { setRunErr(run); return; }
    const { key, field } = statementErrorKey(e as { status?: unknown; code?: unknown });
    const code = (e as { code?: unknown })?.code;
    setErr((key && label(key)) || (typeof code === "string" && label(code)) || describeError(e).text);
    if (key === "error.import_invalid") setErrDetail(describeError(e).detail);
    if (field === "bank") setTimeout(() => bankRef.current?.focus(), 0);
  };
  /** Back to the file step with nothing picked (a new source, an expired preview). */
  const resetFile = () => {
    setFile(null); setPreview(null); setAll(false); setOnlyNew(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const pickSource = (v: string) => {
    if (v !== source) resetFile(); // a file picked for one source is never sent with another
    setSource(v);
  };
  const runPreview = async () => {
    if (!file) return;
    if (maxBytes && file.size > maxBytes) { setErr(label("error.file_too_large")); return; }
    setBusy(true); clearErr();
    try {
      const p = await postStatementPreview(slug, { file, bank: fileBank, account_type: accountType, account_name: accountName });
      setPreview(p); setAll(false); setStep(2);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true); clearErr();
    try {
      const r = await postStatementCommit(slug, {
        file_id: preview.file_id, file_name: preview.file_name, bank: preview.bank.id,
        account_type: accountType, ...(accountName.trim() ? { account_name: accountName.trim() } : {}),
      });
      setDone(r); setStep(3); onDone(r);
    } catch (e) {
      // the staged file is gone (pruned after 24 h, committed in another window): pick the file again
      if (e instanceof ApiError && e.status === 404) { resetFile(); setStep(1); setErr(label("import.preview_expired")); }
      else fail(e);
    } finally { setBusy(false); }
  };
  const again = () => {
    resetFile(); setDone(null); clearErr();
    setStep(1);
  };

  const counts = preview?.counts;
  // The account's bank (the importer may be a format or a connector); "Plik importowany już" only for the same bytes.
  const accBank = preview ? preview.account.institution?.name || bankName(preview.account.institution?.id ?? preview.bank.id, choices) : "";
  const again0 = preview?.previous_imports.find((p) => p.same_file !== false) ?? null;
  const { shown, rest } = preview ? previewRows(preview.rows, onlyNew, all) : { shown: [], rest: 0 };
  const cli = cliPrefix(setup.data, slug);
  const importerLabel = preview ? preview.bank.name || bankName(preview.bank.id, choices) : "";
  const viaConnector = !!preview?.bank.id.startsWith("connector:");
  const bankLine = !preview ? "" : viaConnector && preview.bank.detected ? `rozpoznano: ${importerLabel} (konektor)`
    : `${importerLabel}${preview.bank.detected ? " (rozpoznany)" : ""}`;
  // A fetch binding of this account (read-only hint, D3: bindings live in Ustawienia › Konektory).
  const bound = preview?.account.id != null ? (bindings.data ?? []).find((b) => b.account_id === preview.account.id && b.module === "budget") : undefined;

  const footer = step === 0 ? (
    source === "open_banking" ? (
      <>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => { onClose(); go({ kind: "setup", module: "budget", cli: true }); }}>Instrukcja</button>
        <button className="btn" onClick={onClose}>Zamknij</button>
      </>
    ) : (
      <><span style={{ flex: 1 }} /><button className="btn primary" disabled={!isFileSource(source)} onClick={() => setStep(1)}>Dalej</button></>
    )
  ) : step === 1 ? (
    <>
      {/* the file input remounts empty on step 0 -> 1: no file kept that the input does not show */}
      <button className="btn" onClick={() => { clearErr(); resetFile(); setStep(0); }}>← Wstecz</button>
      <span style={{ flex: 1 }} />
      {connector?.timeout_s != null && <span className="fhint">do {connector.timeout_s} s</span>}
      <button className="btn primary" disabled={!file || busy} onClick={runPreview}>{busy ? (connector ? "Uruchamiam konektor…" : "Sprawdzam…") : "Podgląd"}</button>
    </>
  ) : step === 2 && preview ? (
    <>
      <button className="btn" onClick={() => setStep(1)}>← Wstecz</button>
      <span style={{ flex: 1 }} />
      <button className="btn primary" disabled={busy || !counts?.new} onClick={commit}>
        {busy ? "Importuję…" : `Importuj ${plural(counts?.new ?? 0, "transakcję", "transakcje", "transakcji")}`}
      </button>
    </>
  ) : (
    <><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Zamknij</button></>
  );

  return (
    <Drawer open title="Import wyciągu" tag={preview ? <Tag>{accBank || preview.bank.name}</Tag> : undefined}
      width={600} footer={footer} onClose={onClose} label="Import wyciągu">
      <Stepper steps={["Źródło", "Plik", "Podgląd", "Gotowe"]} current={step} />
      {err && (
        <Notice tone="neg">
          {err}
          {errDetail && <div className="fhint" style={{ marginTop: 2, whiteSpace: "pre-line" }}>{errDetail}</div>}
        </Notice>
      )}
      {runErr && <RunError {...runErr} />}

      {step === 0 && (
        <>
          <RadioList<string> name="imp-src" value={source} onChange={pickSource} options={sources} />
          {source === "open_banking" && (ebConfigured ? (
            <>
              <Code cmd={`${cli} eb login "mBank"`} />
              <div className="fhint">Po zalogowaniu w banku: ↻ Synchronizuj w pasku zakładek pobierze transakcje.</div>
            </>
          ) : (
            <Notice tone="warn" action={<button className="btn" onClick={() => { onClose(); go({ kind: "settings", section: "secrets" }); }}>Ustawienia</button>}>
              Enable Banking nie jest skonfigurowany: identyfikator aplikacji i klucz w Ustawieniach › Sekrety.
            </Notice>
          ))}
        </>
      )}

      {step === 1 && (
        <>
          <div className="field">
            <label htmlFor="st-file">Plik z banku</label>
            <input id="st-file" ref={fileRef} type="file" accept={connector?.extensions.length ? acceptOf(connector.extensions) : ".csv,.json,text/csv,application/json"} data-autofocus
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); clearErr(); }} />
            <span className="fhint">Plik zostaje na tym komputerze.</span>
          </div>
          {connector && (
            <div className="field">
              <span style={{ fontSize: 12, color: "var(--muted)" }}>Konektor</span>
              <span><b>{connector.name}</b>{connector.version && <span className="fhint"> v{connector.version}</span>}</span>
            </div>
          )}
          {!source.startsWith("connector:") && (
            <div className="field">
              <label htmlFor="st-bank">Bank</label>
              <select id="st-bank" ref={bankRef} value={bank} onChange={(e) => setBank(e.target.value)}>
                {bankOptions(choices).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          )}
          <div className="form-row">
            <div className="field">
              <label htmlFor="st-type">Typ konta</label>
              <select id="st-type" value={accountType} onChange={(e) => setAccountType(e.target.value)}>
                {STATEMENT_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="st-name">Nazwa konta (opcjonalnie)</label>
              <input id="st-name" value={accountName} placeholder="z pliku" maxLength={80} autoComplete="off" onChange={(e) => setAccountName(e.target.value)} />
            </div>
          </div>
        </>
      )}

      {step === 2 && preview && counts && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            <code>{preview.file_name}</code> · {bankLine} · {plural(counts.rows, "wiersz", "wiersze", "wierszy")}
            {preview.range ? ` · ${dmShort(preview.range.from)}-${dmShort(preview.range.to)}` : ""} · <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setStep(1)}>zmień</button>
          </div>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            Konto: <b>{[accBank, preview.account.name, preview.account.iban_tail ? `…${preview.account.iban_tail}` : null, preview.account.currency].filter(Boolean).join(" · ")}</b>
            {bound && <span className="muted"> · synchronizowane konektorem {bound.connector_name}</span>}{" "}
            {preview.account.existing
              ? <Tag>istnieje · {plural(preview.account.transactions, "transakcja", "transakcje", "transakcji")}</Tag>
              : <Tag tone="info">nowe</Tag>}
          </div>
          {again0 && <Notice tone="warn">Plik importowany już {dmShort(again0.at)}: powtórzone wiersze to duplikaty.</Notice>}
          {!!preview.warnings?.length && (
            <Notice tone="warn">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {preview.warnings.slice(0, 5).map((w, k) => {
                  const d = describeImportWarning({ kind: w.kind, code: w.code, message: w.message });
                  return <li key={k}>{w.row != null ? `wiersz ${w.row}: ` : ""}{d.text}</li>;
                })}
              </ul>
            </Notice>
          )}
          <div className="controls" style={{ marginBottom: 8 }}>
            <Tag tone="pos" solid>{plural(counts.new, "nowy", "nowe", "nowych")}</Tag>
            <Tag title={counts.overlap ? `w tym ${counts.overlap} z innego źródła (bank, CSV)` : undefined}>{plural(counts.duplicates, "duplikat", "duplikaty", "duplikatów")}</Tag>
            {counts.skipped > 0 && <Tag tone="warn" solid title="wiersze bez daty albo kwoty">{plural(counts.skipped, "pominięty", "pominięte", "pominiętych")}</Tag>}
            <span className="spacer" />
            <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" className="check" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> pokaż tylko nowe
            </label>
          </div>
          {counts.new === 0 && <Notice tone="info">Wszystkie wiersze już są w bazie.</Notice>}
          <table>
            <thead><tr><th>Data</th><th>Tytuł</th><th>Kontrahent</th><th className="num">Kwota</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const dup = r.status === "duplicate";
                return (
                  <tr key={r.row} style={dup ? { color: "var(--muted)" } : undefined}>
                    <td>{r.date}</td>
                    <td>{r.title || <span className="muted">-</span>}</td>
                    <td className={r.counterparty ? undefined : "muted"}>{r.counterparty || "-"}</td>
                    <td className={`num ${dup ? "" : r.amount > 0 ? "pos" : r.amount < 0 ? "neg" : ""}`}>{signed(r.amount, r.currency)}</td>
                    <td>{dup ? <Tag>duplikat</Tag> : <Tag tone="pos">nowy</Tag>}</td>
                  </tr>
                );
              })}
              {rest > 0 && (
                <tr><td colSpan={5} className="muted" style={{ textAlign: "center", fontSize: 12 }}>
                  … {rest} kolejnych wierszy · <button className="lnk" style={{ fontSize: 12 }} onClick={() => setAll(true)}>pokaż wszystkie</button>
                </td></tr>
              )}
              {!shown.length && <tr><td colSpan={5} className="muted">{onlyNew ? "Brak nowych wierszy." : "Plik nie zawiera transakcji."}</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {step === 3 && done && (
        <div className="empty" style={{ textAlign: "left", padding: "8px 0" }}>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>Zaimportowano {plural(done.inserted, "transakcję", "transakcje", "transakcji")}.</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{importDoneLine(done)}</div>
          <div className="controls" style={{ justifyContent: "flex-start" }}>
            <button className="btn" onClick={again}>Importuj kolejny plik</button>
            {!fromTab && <button className="btn primary" onClick={() => { onClose(); go({ kind: "tab", tab: "budget.expenses" }); }}>Wydatki →</button>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
