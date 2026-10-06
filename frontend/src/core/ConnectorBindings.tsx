// Fetch bindings of one connector in the current profile (design/v3/connectors section 4): the only place with the
// binding form (account, params, write-only secrets, auto-commit). A row syncs on demand; a sync that needs
// approval becomes a proposal the parent opens.
import { useState } from "react";
import { useAsync } from "../hooks";
import { Notice, Switch, Tag, useToast } from "../ui";
import { ApiError, getNetworth } from "./api";
import {
  AUTO_RULE, backoffActive, effectiveAccount, lastSyncText, newSecrets, problemText, secretChanges, secretMissing, secretsLeftText, secretsText,
  syncToast, when,
} from "./connectors";
import {
  type Binding, type ConnectorDetail, type ConnectorParam, deleteBinding, getBindings, postBinding, postBindingCheck, postBindingSync, putBinding,
  putBindingSecrets, type RunDict,
} from "./connectorsApi";
import { useShell } from "./context";
import { type Described, describeError, errorText } from "./messages";
import { RunError } from "./RunError";
import { getAccounts } from "../modules/investments/api";
import { accountLabel } from "../modules/investments/labels";
import { bankAccounts } from "../modules/budget/logic";

interface Acc { id: number; label: string }

/** The module's accounts the connector can bind to (investments brokerage accounts, budget bank accounts). */
async function moduleAccounts(slug: string, module: string): Promise<Acc[]> {
  if (module === "investments") {
    const rows = await getAccounts(slug);
    return rows.map((a) => ({ id: a.id, label: accountLabel(a, rows) }));
  }
  const nw = await getNetworth(slug);
  return bankAccounts(nw.accounts ?? [])
    .map((a) => ({ id: a.id, label: [a.bank, a.name, a.iban_tail ? `…${a.iban_tail}` : null].filter(Boolean).join(" · ") }));
}

export function BindingsPanel({ connector, onChanged, onProposal }: {
  connector: ConnectorDetail; onChanged: () => void; onProposal: (proposalId: number) => void;
}) {
  const { slug, profile, refresh } = useShell();
  const toast = useToast();
  const [n, setN] = useState(0);
  const b = useAsync(() => getBindings(slug), [slug, n]);
  const accs = useAsync(() => moduleAccounts(slug, connector.module).catch(() => [] as Acc[]), [slug, connector.module]);
  const mine = (b.data ?? []).filter((x) => x.connector_id === connector.id);
  const approved = connector.status === "approved";
  const [form, setForm] = useState<"new" | number | null>(null);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [failed, setFailed] = useState<Record<number, RunDict>>({});
  const changed = () => { setN((x) => x + 1); onChanged(); };
  const labelOf = (x: Binding) => x.account_label || accs.data?.find((a) => a.id === x.account_id)?.label || `konto ${x.account_id}`;
  // null while the accounts or the bindings load: the form says so instead of "every account is bound"
  const free = accs.data && b.data ? accs.data.filter((a) => !mine.some((x) => x.account_id === a.id)) : null;

  const sync = async (x: Binding) => {
    setSyncing(x.id);
    setFailed((f) => { const o = { ...f }; delete o[x.id]; return o; });
    try {
      const r = await postBindingSync(slug, x.id);
      const run = r.run;
      if (run && !run.ok) setFailed((f) => ({ ...f, [x.id]: run }));
      const problem = run?.ok ? problemText(r.problem) : null;
      const text = problem ?? syncToast(r, r.account || labelOf(x));
      if (problem) toast(problem, 5000);
      else if (text && r.proposal_id != null) {
        const pid = r.proposal_id;
        toast(text, 5000, { label: "Zobacz", onClick: () => onProposal(pid) });
      } else if (text) toast(text, r.committed?.inserted ? 4000 : 2500);
      if (r.committed?.inserted) refresh?.();
      changed();
    } catch (e) { toast(errorText(e), 5000); } finally { setSyncing(null); }
  };

  return (
    <>
      <div className="kick">
        <span className="kicker">Powiązania · {profile.name}</span>
        <Tag>{mine.length}</Tag>
        <span className="spacer" />
        {form !== "new" && (
          <button className="btn" disabled={!approved} title={!approved ? "Najpierw zatwierdź konektor" : undefined} onClick={() => setForm("new")}>+ Powiąż konto</button>
        )}
      </div>
      {b.error && <Notice tone="neg">{b.error}</Notice>}
      {form === "new" && (
        <BindingForm connector={connector} accounts={free} onCancel={() => setForm(null)}
          onSaved={(x) => { toast(`Powiązano ${labelOf(x)}`, 2500); changed(); }} onDone={() => setForm(null)} labelOf={labelOf} />
      )}
      {mine.map((x) => form === x.id ? (
        <BindingForm key={x.id} connector={connector} binding={x} accounts={[]} onCancel={() => setForm(null)} labelOf={labelOf}
          onSaved={() => { toast("Zapisano", 2000); changed(); }} onDone={() => setForm(null)}
          onRemoved={(left) => {
            const kept = secretsLeftText(left, connector.id);
            toast(kept ? `Odłączono ${labelOf(x)} · ${kept}` : `Odłączono ${labelOf(x)}`, kept ? 8000 : 2500);
            setForm(null); changed();
          }} />
      ) : (
        <div className="row" key={x.id}>
          <div className="grow">
            <div className="t">
              {labelOf(x)}
              {x.auto_commit
                ? <Tag tone="pos" title={AUTO_RULE}>automatyczny zapis</Tag>
                : <Tag title="Każdy wynik czeka na Twoje zatwierdzenie">do zatwierdzenia</Tag>}
              {!x.has_commit && <Tag title="Pierwsza synchronizacja zawsze czeka na zatwierdzenie">po pierwszym imporcie</Tag>}
              {backoffActive(x.backoff_until) && (
                <Tag tone="warn" title="Serwis ograniczył liczbę zapytań">limit API do {when(x.backoff_until)}</Tag>
              )}
              {secretMissing(x) && <Tag tone="warn" solid>brak sekretu</Tag>}
            </div>
            <div className="d">{lastSyncText(x)} · sekrety: {secretsText(x)}</div>
            {failed[x.id] && <RunDictError run={failed[x.id]} timeoutS={connector.timeout_s} />}
          </div>
          <button className="btn" disabled={syncing != null || !approved || secretMissing(x)}
            title={secretMissing(x) ? "Uzupełnij sekrety (Edytuj)" : undefined} onClick={() => sync(x)}>
            {syncing === x.id ? "Pobieram…" : "Synchronizuj"}
          </button>
          <button className="lnk" onClick={() => setForm(x.id)}>Edytuj</button>
        </div>
      ))}
      {b.data && !mine.length && form !== "new" && (
        <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>
          {approved ? "Brak powiązań w tym profilu. Powiąż konto, wpisz klucz, sprawdź połączenie." : "Powiązania po zatwierdzeniu."}
        </div>
      )}
    </>
  );
}

function RunDictError({ run, timeoutS }: { run: RunDict; timeoutS?: number | null }) {
  return <RunError kind={run.error_kind ?? "internal"} message={run.message} stderr={run.stderr_tail} timeoutS={timeoutS} style={{ margin: "6px 0 0" }} />;
}

/** `start: must be a date (YYYY-MM-DD); x: required` (the server's 422 text) -> per-field messages. */
function paramErrors(e: unknown, params: ConnectorParam[]): Record<string, string> {
  if (!(e instanceof ApiError) || e.status !== 422) return {};
  const ids = new Set(params.map((p) => p.id));
  const out: Record<string, string> = {};
  const body = e.body as { params?: Record<string, string> } | null;
  if (body?.params) {
    for (const [k, v] of Object.entries(body.params)) out[k] = /required|missing/i.test(String(v)) ? "Wymagane." : "Nieprawidłowa wartość.";
    return out;
  }
  for (const part of e.message.replace(/^[^:]*params:\s*/, "").split(/;\s*/)) {
    const m = /^([a-z0-9_-]+):\s*(.+)$/i.exec(part);
    if (m && ids.has(m[1])) out[m[1]] = /required|missing/i.test(m[2]) ? "Wymagane." : "Nieprawidłowa wartość.";
  }
  return out;
}

const paramValue = (p: ConnectorParam, raw: unknown): unknown => {
  if (p.type === "boolean") return !!raw;
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (p.type === "number") { const n = Number(s.replace(",", ".")); return Number.isFinite(n) ? n : s; }
  return s;
};

function BindingForm({ connector, binding, accounts: offered, onCancel, onSaved, onDone, onRemoved, labelOf }: {
  /** null: the accounts (or the bindings) are still loading. */
  connector: ConnectorDetail; binding?: Binding; accounts: Acc[] | null; labelOf: (b: Binding) => string;
  onCancel: () => void; onSaved: (b: Binding) => void; onDone: () => void; onRemoved?: (secretsLeft: number) => void;
}) {
  const { slug } = useShell();
  const edit = !!binding;
  const accounts = offered ?? [];
  const [chosen, setAccount] = useState<number | null>(null);
  // the list may arrive (or change) after mount: the select's shown option is the one saved
  const account = effectiveAccount(chosen, accounts);
  const [params, setParams] = useState<Record<string, unknown>>(() => ({ ...(binding?.params ?? {}) }));
  // secrets: a typed value (set), null (clear), absent (keep)
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [auto, setAuto] = useState(binding?.auto_commit ?? false);
  const [busy, setBusy] = useState<null | "save" | "check" | "remove">(null);
  const [tried, setTried] = useState(false);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [accErr, setAccErr] = useState<string | null>(null);
  const [err, setErr] = useState<Described | null>(null);
  const [check, setCheck] = useState<RunDict | null>(null);
  const [created, setCreated] = useState<Binding | null>(null);
  const [confirm, setConfirm] = useState(false);
  const isSet = (id: string) => !!binding?.secrets_set.includes(id) && secrets[id] !== null && !editing.has(id);
  const secretDirty = Object.keys(secrets).length > 0;

  const missing = (p: ConnectorParam) => !!p.required && paramValue(p, params[p.id]) === undefined;
  const missingSecret = (id: string) => !isSet(id) && !(typeof secrets[id] === "string" && secrets[id]!.trim());
  const body = () => Object.fromEntries(connector.params.map((p) => [p.id, paramValue(p, params[p.id])]).filter(([, v]) => v !== undefined));

  const runCheck = async (id: number) => {
    setBusy("check"); setCheck(null);
    try { setCheck(await postBindingCheck(slug, id)); } catch (e) { setErr(describeError(e)); } finally { setBusy(null); }
  };

  const save = async () => {
    setTried(true); setErr(null); setAccErr(null); setFieldErr({});
    if (connector.params.some(missing)) return;
    if (!edit && account == null) { setAccErr(offered ? "Brak konta do powiązania." : "Ładuję konta…"); return; }
    if (!edit && connector.secrets.some((s) => missingSecret(s.id))) return;
    setBusy("save");
    try {
      if (!edit) {
        const b = await postBinding(slug, { connector_id: connector.id, account_id: account!, params: body(), secrets: newSecrets(secrets), auto_commit: auto });
        setCreated(b); setSecrets({});
        onSaved(b);
        setBusy(null);
        await runCheck(b.id);
        return;
      }
      const b = await putBinding(slug, binding!.id, { params: body(), auto_commit: auto });
      if (secretDirty) {
        const out = secretChanges(secrets);
        if (Object.keys(out).length) await putBindingSecrets(slug, binding!.id, out);
      }
      onSaved(b); onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setAccErr("To konto ma już powiązanie z tym konektorem.");
      else {
        const fe = paramErrors(e, connector.params);
        if (Object.keys(fe).length) setFieldErr(fe); else setErr(describeError(e));
      }
    } finally { setBusy((s) => (s === "save" ? null : s)); }
  };
  const remove = async () => {
    setBusy("remove"); setErr(null);
    try {
      const r = await deleteBinding(slug, binding!.id);
      onRemoved?.(r?.secrets_left ?? 0);
    } catch (e) { setErr(describeError(e)); setConfirm(false); } finally { setBusy(null); }
  };

  const fe = (id: string, need: boolean, text: string) => (fieldErr[id] ? <span className="fe">{fieldErr[id]}</span> : tried && need ? <span className="fe">{text}</span> : null);
  const done = !!created;

  return (
    <div className="bindform">
      {/* created: the bound account by its binding (the offered list no longer holds it once the bindings reload) */}
      {edit || created ? (
        <div style={{ fontSize: 13, marginBottom: 10 }}>Konto: <b>{labelOf((binding ?? created)!)}</b></div>
      ) : (
        <div className="field">
          <label htmlFor="bf-acc">Konto</label>
          {accounts.length ? (
            <select id="bf-acc" value={account ?? ""} disabled={done} onChange={(e) => setAccount(Number(e.target.value))}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          ) : <span style={{ fontSize: 13 }}>{offered ? "Każde konto tego modułu ma już powiązanie." : "Ładuję konta…"}</span>}
          {accErr && <span className="fe">{accErr}</span>}
        </div>
      )}
      {connector.params.length > 0 && (
        <div className="form-row">
          {connector.params.map((p) => (
            <div className="field" key={p.id}>
              {p.type === "boolean" ? (
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--text)" }}>
                  <input type="checkbox" className="check" checked={!!params[p.id]} disabled={done} onChange={(e) => setParams({ ...params, [p.id]: e.target.checked })} /> {p.label}
                </label>
              ) : (
                <>
                  <label htmlFor={`bf-p-${p.id}`}>{p.label}{p.required ? " *" : ""}</label>
                  <input id={`bf-p-${p.id}`} disabled={done} type={p.type === "date" ? "date" : "text"} className={p.type === "number" ? "num" : undefined}
                    inputMode={p.type === "number" ? "decimal" : undefined} maxLength={200} autoComplete="off" spellCheck={false}
                    value={String(params[p.id] ?? "")} onChange={(e) => setParams({ ...params, [p.id]: e.target.value })} />
                </>
              )}
              {fe(p.id, missing(p), "Wymagane.")}
            </div>
          ))}
        </div>
      )}
      {connector.secrets.map((s) => (
        <div className="field" key={s.id}>
          <label htmlFor={`bf-s-${s.id}`}>{s.label}</label>
          {isSet(s.id) ? (
            <div className="inline">
              <Tag tone="pos">ustawiony</Tag>
              <button className="lnk" onClick={() => setEditing(new Set([...editing, s.id]))}>zmień</button>
              <button className="lnk" onClick={() => setSecrets({ ...secrets, [s.id]: null })}>wyczyść</button>
            </div>
          ) : (
            <input id={`bf-s-${s.id}`} type="password" autoComplete="new-password" spellCheck={false} placeholder="wklej klucz" disabled={done}
              value={typeof secrets[s.id] === "string" ? secrets[s.id]! : ""}
              onChange={(e) => setSecrets({ ...secrets, [s.id]: e.target.value })} />
          )}
          {!edit && fe(s.id, missingSecret(s.id), "Podaj klucz.")}
        </div>
      ))}
      {connector.secrets.length > 0 && <div className="fhint" style={{ margin: "-6px 0 10px" }}>Zostaje w pęku kluczy macOS; konektor dostaje go tylko podczas przebiegu.</div>}
      <div className="controls" style={{ fontSize: 13, margin: "0 0 10px" }}>
        <Switch on={auto} label="Automatyczny zapis" title={AUTO_RULE} onChange={setAuto} disabled={done} />
        <span title={AUTO_RULE}>Automatyczny zapis</span>
        {!binding?.has_commit && <Tag>po pierwszym imporcie</Tag>}
      </div>
      {err && (
        <Notice tone="neg" style={{ margin: "0 0 8px" }}>
          {err.text}
          {err.detail && <div className="fhint" style={{ marginTop: 2 }}>{err.detail}</div>}
        </Notice>
      )}
      {confirm ? (
        <div className="controls" style={{ justifyContent: "flex-end", fontSize: 13 }}>
          <span>Odłączyć {labelOf(binding!)}? Usunie sekrety tego powiązania.</span>
          <span className="spacer" />
          <button className="btn" disabled={busy != null} onClick={() => setConfirm(false)}>Anuluj</button>
          <button className="btn" disabled={busy != null} style={{ color: "var(--neg)", borderColor: "var(--neg)" }} onClick={remove}>Tak, odłącz</button>
        </div>
      ) : done ? (
        <div className="controls" style={{ justifyContent: "flex-end" }}>
          <button className="btn" disabled={busy != null} onClick={() => runCheck(created!.id)}>{busy === "check" ? "Sprawdzam…" : "Sprawdź połączenie"}</button>
          <button className="btn primary" disabled={busy != null} onClick={onDone}>Gotowe</button>
        </div>
      ) : (
        <div className="controls" style={{ justifyContent: "flex-end" }}>
          {edit && <button className="lnk" style={{ color: "var(--neg)" }} disabled={busy != null} onClick={() => setConfirm(true)}>Odłącz</button>}
          <span className="spacer" />
          <button className="btn" disabled={busy != null} onClick={onCancel}>Anuluj</button>
          {edit && (
            <button className="btn" disabled={busy != null || secretDirty} title={secretDirty ? "Najpierw zapisz" : undefined} onClick={() => runCheck(binding!.id)}>
              {busy === "check" ? "Sprawdzam…" : "Sprawdź połączenie"}
            </button>
          )}
          <button className="btn primary" disabled={busy != null || (!edit && !accounts.length)} onClick={save}>
            {busy === "save" ? "Zapisuję…" : edit ? "Zapisz" : "Zapisz i sprawdź"}
          </button>
        </div>
      )}
      {check && (check.ok
        ? <Notice tone="pos" style={{ margin: "8px 0 0" }}>Połączono · {((check.duration_ms ?? 0) / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} s</Notice>
        : <RunDictError run={check} timeoutS={connector.timeout_s} />)}
    </div>
  );
}
