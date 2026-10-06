// One installed connector (design/v3/connectors section 3): what the owner approves (command, interpreter,
// network, secrets, hash) first and bold, then the quiet facts, the files with the code viewer (a `changed`
// file shows its line diff against the approved copy), the profile's fetch bindings, the run history.
// Approve sends the hash and interpreter this drawer loaded; a 409 reloads it and asks to look again.
import { type ReactNode, useState } from "react";
import { useAsync } from "../hooks";
import { copyText, Drawer, Notice, Skeleton, Tag, useToast } from "../ui";
import { ApiError } from "./api";
import { BindingsPanel } from "./ConnectorBindings";
import {
  changedSinceApproval, diffSummary, fileChange, KIND_LABEL, kindShort, MODULE_LABEL, OUTCOME_LABEL, OUTCOME_TONE, parseUnifiedDiff,
  secretsLeftText, sizeText, sortFiles, statusOf, viewable, when,
} from "./connectors";
import {
  type ConnectorDetail, type ConnectorFile, type ConnectorRun, deleteConnector, getConnector, getConnectorDiff, getConnectorFile, getConnectorRuns,
  postConnectorApprove, postConnectorDisable,
} from "./connectorsApi";
import { useShell } from "./context";
import { errorText, plural } from "./messages";
import { RunError } from "./RunError";

export function StatusTag({ status }: { status: string }) {
  const [text, tone, solid] = statusOf(status);
  return <Tag tone={tone} solid={solid}>{text}</Tag>;
}

const CHANGE_TAG: Record<string, [string, "warn" | "info" | "neg"]> = {
  modified: ["zmieniony", "warn"], added: ["dodany", "info"], removed: ["usunięty", "neg"],
};
function ChangeTag({ change }: { change: string | null }) {
  if (!change) return null;
  const [t, tone] = CHANGE_TAG[change];
  return <Tag tone={tone} solid>{t}</Tag>;
}

const Kick = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="kick"><span className="kicker">{children}</span>{right}</div>
);

export function ConnectorDrawer({ id, onClose, onChanged, onProposal }: {
  id: string; onClose: () => void;
  /** After any write (approve, disable, delete, a binding change): the list re-reads. */
  onChanged: () => void;
  /** A sync stored a proposal and the owner asked to see it: the parent closes this drawer and opens it. */
  onProposal: (proposalId: number) => void;
}) {
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  const p = useAsync(() => getConnector(id), [id, nonce]);
  const d = p.data;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [view, setView] = useState<string | null>(null);

  const approve = async () => {
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      // the values this drawer showed, never re-read before sending
      await postConnectorApprove(id, { content_sha256: d.content_sha256, interpreter_path: d.interpreter_path });
      toast(`Zatwierdzono ${d.name}`, 2500);
      onChanged(); reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setErr("Konektor zmienił się, odkąd go otworzyłeś: sprawdź pliki jeszcze raz."); reload(); }
      else setErr(`Nie można zatwierdzić: ${errorText(e)}`);
    } finally { setBusy(false); }
  };
  const disable = async () => {
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      await postConnectorDisable(id);
      toast(`Wyłączono ${d.name}`, 2500);
      onChanged(); reload();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!d) return;
    setBusy(true); setErr(null);
    try {
      const r = await deleteConnector(id);
      const kept = secretsLeftText(r?.secrets_left, d.id);
      toast(kept ? `Usunięto ${d.name} · ${kept}` : `Usunięto ${d.name}`, kept ? 8000 : 2500);
      onChanged(); onClose();
    } catch (e) { setErr(errorText(e)); setConfirmDelete(false); } finally { setBusy(false); }
  };

  const blocked = !!d && (d.missing || d.problems.length > 0);
  const footer = !d ? undefined : confirmDelete ? (
    <>
      <span style={{ fontSize: 13 }}>Usunąć <b>{d.name}</b>?{d.bindings ? ` Usunie też ${plural(d.bindings, "powiązanie", "powiązania", "powiązań")} i ich sekrety.` : ""}</span>
      <span style={{ flex: 1 }} />
      <button className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>Anuluj</button>
      <button className="btn" disabled={busy} style={{ color: "var(--neg)", borderColor: "var(--neg)" }} onClick={remove}>Tak, usuń</button>
    </>
  ) : (
    <>
      <button className="btn" disabled={busy} onClick={() => setConfirmDelete(true)}>Usuń</button>
      {(d.status === "changed" || d.status === "approved") && <button className="btn" disabled={busy} onClick={disable}>Wyłącz</button>}
      <span style={{ flex: 1 }} />
      {d.status !== "approved" && (
        <button className="btn primary" disabled={busy || blocked} onClick={approve}>
          {d.status === "changed" ? "Zatwierdź ponownie" : d.status === "disabled" ? "Zatwierdź i włącz" : "Zatwierdź"}
        </button>
      )}
    </>
  );

  return (
    <Drawer open title={d?.name ?? "Konektor"} tag={d ? <StatusTag status={d.status} /> : undefined} width={640} footer={footer} onClose={onClose} label="Konektor">
      {err && <Notice tone="neg">{err}</Notice>}
      {p.error && !d && <Notice tone="neg">{p.error}</Notice>}
      {!d && !p.error && <Skeleton h={200} />}
      {d && (
        <>
          <Notices d={d} />
          <Approves d={d} />
          <Details d={d} />
          <Files d={d} view={view} setView={setView} nonce={nonce} />
          {d.kind === "fetch" && (
            <BindingsPanel connector={d} onChanged={() => { onChanged(); reload(); }}
              onProposal={(pid) => { onClose(); onProposal(pid); }} />
          )}
          <Runs id={id} kind={d.kind} nonce={nonce} />
          <div className="foot">Wyłączenie zatrzymuje przebiegi, powiązania zostają. Usunięcie kasuje katalog, powiązania i sekrety.</div>
        </>
      )}
    </Drawer>
  );
}

function Notices({ d }: { d: ConnectorDetail }) {
  const summary = diffSummary(d.diff);
  const shown = d.problems.slice(0, 6);
  return (
    <>
      {changedSinceApproval(d) && (
        <Notice tone="warn">
          Pliki zmieniły się od zatwierdzenia{summary ? ` (${summary})` : ""}.{" "}
          {d.status === "disabled" ? "Przejrzyj zmiany przed włączeniem." : "Konektor nie uruchomi się do ponownego zatwierdzenia."}
          {d.interpreter_changed && <> Interpreter: było <code>{d.approved_interpreter}</code>, jest <code>{d.interpreter_path}</code>.</>}
        </Notice>
      )}
      {d.missing && <Notice tone="neg">Katalog konektora zniknął z dysku. Zostaje tylko usunięcie.</Notice>}
      {d.problems.length > 0 && (
        <Notice tone="neg">
          <b>Konektor nie przechodzi walidacji:</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {shown.map((x, k) => <li key={k}>{x}</li>)}
            {d.problems.length > shown.length && <li>… i {d.problems.length - shown.length} więcej</li>}
          </ul>
        </Notice>
      )}
      {d.status === "disabled" && <Notice>Wyłączony: nie uruchamia się; powiązania i sekrety zostały.</Notice>}
      {d.status === "pending" && d.source === "mcp" && (
        <Notice tone="info">Zgłoszony przez agenta. Przejrzyj polecenie, hosty i pliki poniżej; agent nie może go zatwierdzić ani uruchomić.</Notice>
      )}
    </>
  );
}

function Approves({ d }: { d: ConnectorDetail }) {
  const toast = useToast();
  const run = d.run ?? [];
  const local = run[0]?.startsWith("./");
  const fetch = d.kind === "fetch";
  return (
    <>
      <Kick>Co zatwierdzasz</Kick>
      <div className="kv ckv">
        <span className="k">Polecenie</span>
        <span className="v block">
          <code style={{ fontWeight: 600 }}>{run.join(" ") || "-"}</code>
          <div style={{ marginTop: 2 }}>
            {local
              ? <span className="fhint">plik wykonywalny z katalogu konektora (objęty sumą kontrolną)</span>
              : <><span className="fhint">interpreter </span><code style={{ fontSize: 12 }}>{d.interpreter_path ?? "-"}</code></>}
          </div>
        </span>
        <span className="k">Limit czasu</span>
        <span className="v"><b>{d.timeout_s} s</b>{d.kind === "file" && <span className="fhint">rozpoznawanie pliku 10 s</span>}</span>
        <span className="k">Sieć</span>
        <span className="v">
          {fetch
            ? <>{d.hosts.map((h) => <code key={h} style={{ fontWeight: 600 }}>{h}</code>)}<span className="fhint">tylko te hosty, port 443, przez proxy aplikacji</span></>
            : <><b>brak</b><span className="fhint">piaskownica bez dostępu do sieci</span></>}
        </span>
        {fetch && d.secrets.length > 0 && (
          <>
            <span className="k">Sekrety</span>
            <span className="v block">
              {d.secrets.map((s) => <div key={s.id}><b>{s.label}</b> <span className="fhint">({s.id})</span></div>)}
              <span className="fhint">wpisujesz w powiązaniu; pęk kluczy; nigdy w logach ani u agenta</span>
            </span>
          </>
        )}
        {fetch && d.params.length > 0 && (
          <>
            <span className="k">Parametry</span>
            <span className="v">{d.params.map((x) => `${x.label}${x.required ? " *" : ""}`).join(" · ")}{d.params.some((x) => x.required) && <span className="fhint">* wymagany</span>}</span>
          </>
        )}
        {d.kind === "file" && (
          <><span className="k">Rozszerzenia</span><span className="v">{d.extensions.join(", ") || "-"}</span></>
        )}
        {fetch && d.history_days != null && (
          <><span className="k">Historia</span><span className="v">pierwsze pobranie: {d.history_days} dni wstecz</span></>
        )}
        <span className="k">Suma kontrolna</span>
        <span className="v">
          <code title={d.content_sha256}>sha256 {d.content_sha256.slice(0, 12)}…</code>
          <button className="lnk" onClick={() => copyText(d.content_sha256).then(() => toast("Skopiowano", 1500))}>kopiuj</button>
          {d.approved_sha256 && d.approved_sha256 !== d.content_sha256 && (
            <span style={{ color: "var(--neg)", fontSize: 12.5 }}>zatwierdzona <code title={d.approved_sha256}>{d.approved_sha256.slice(0, 12)}…</code></span>
          )}
        </span>
        <span className="k">Zapis na dysku</span>
        <span className="v">tylko katalog tymczasowy przebiegu</span>
      </div>
      <div className="fhint" style={{ marginTop: 8 }}>Piaskownica: odczyt systemu i własnego katalogu, zapis tylko do katalogu tymczasowego; proces zabijany po limicie czasu.</div>
    </>
  );
}

function Details({ d }: { d: ConnectorDetail }) {
  return (
    <>
      <Kick>Szczegóły</Kick>
      <div className="kv ckv" style={{ fontSize: 13 }}>
        <span className="k">Identyfikator</span><span className="v"><code>{d.id}</code></span>
        <span className="k">Wersja</span><span className="v">{d.version}</span>
        <span className="k">Autor</span><span className="v">{d.author ?? "-"}</span>
        <span className="k">Opis</span><span className="v">{d.description ?? "-"}</span>
        <span className="k">Moduł</span><span className="v">{MODULE_LABEL[d.module] ?? d.module}</span>
        <span className="k">Rodzaj</span><span className="v">{KIND_LABEL[d.kind] ?? d.kind}</span>
        <span className="k">Zainstalowany</span><span className="v">{when(d.installed_at)} · {d.source === "mcp" ? "agent (MCP)" : "CLI"}</span>
        <span className="k">Zatwierdzony</span><span className="v">{d.approved_at ? when(d.approved_at) : "-"}</span>
      </div>
    </>
  );
}

interface FileRow { path: string; size: number | null; executable?: boolean; change: string | null }

function Files({ d, view, setView, nonce }: { d: ConnectorDetail; view: string | null; setView: (p: string | null) => void; nonce: number }) {
  const changed = changedSinceApproval(d);
  const rows: FileRow[] = [
    ...sortFiles(d.files).map((f: ConnectorFile) => ({ path: f.path, size: f.size, executable: f.executable, change: changed ? fileChange(d.diff, f.path) : null })),
    ...(changed ? (d.diff?.removed ?? []).map((path) => ({ path, size: null, change: "removed" })) : []),
  ];
  const total = d.files.reduce((s, f) => s + f.size, 0);
  const current = rows.find((r) => r.path === view) ?? null;
  return (
    <>
      <Kick right={<Tag>{plural(d.files.length, "plik", "pliki", "plików")} · {sizeText(total)}</Tag>}>Pliki</Kick>
      <table>
        <thead><tr><th>Plik</th><th className="num">Rozmiar</th>{changed && <th />}</tr></thead>
        <tbody>
          {rows.map((f) => {
            // a removed file has only its diff; any other file opens when the viewer can show it
            const canOpen = f.change === "removed" || (f.size != null && viewable({ path: f.path, size: f.size }));
            return (
              <tr key={f.path} className={f.change === "removed" ? "muted" : undefined}>
                <td>
                  {canOpen
                    ? <button className="lnk" style={{ fontWeight: view === f.path ? 700 : undefined }} aria-pressed={view === f.path} onClick={() => setView(view === f.path ? null : f.path)}>{f.path}</button>
                    : <span className="muted" title="plik binarny albo za duży do podglądu">{f.path}</span>}
                  {f.executable && <> <Tag title="plik wykonywalny">exec</Tag></>}
                </td>
                <td className="num">{f.size != null ? sizeText(f.size) : ""}</td>
                {changed && <td><ChangeTag change={f.change} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {current && <CodeViewer key={`${current.path}:${nonce}`} id={d.id} file={current} onClose={() => setView(null)} />}
    </>
  );
}

type Loaded = { text: string } | { status: number };

/** The code viewer (3.5) and, for a modified or removed file, its line diff against the approved copy. */
function CodeViewer({ id, file, onClose }: { id: string; file: FileRow; onClose: () => void }) {
  const toast = useToast();
  const hasDiff = file.change === "modified" || file.change === "removed";
  const [wanted, setMode] = useState<"diff" | "file">(hasDiff ? "diff" : "file");
  const mode = hasDiff ? wanted : "file"; // approved again while open: the file itself
  const load = (fn: () => Promise<string>) => () => fn().then((text): Loaded => ({ text })).catch((e: unknown): Loaded => {
    if (e instanceof ApiError && [404, 405, 413, 415].includes(e.status)) return { status: e.status };
    throw e;
  });
  const res = useAsync(load(() => (mode === "diff" ? getConnectorDiff(id, file.path) : getConnectorFile(id, file.path))), [id, file.path, mode]);
  const r = res.data;
  const text = r && "text" in r ? r.text : null;
  const diff = mode === "diff" && text != null ? parseUnifiedDiff(text) : null;
  const lines = mode === "file" && text != null ? text.replace(/\n$/, "").split("\n") : [];
  return (
    <div className="codeview" role="region" aria-label={file.path}>
      <div className="cvh">
        <code>{file.path}</code>
        {file.size != null && <span>· {sizeText(file.size)}</span>}
        {mode === "file" && text != null && <span>· {plural(lines.length, "linia", "linie", "linii")}</span>}
        {diff && <span>· <span style={{ color: "var(--pos)" }}>+{diff.added}</span> <span style={{ color: "var(--neg)" }}>-{diff.removed}</span></span>}
        <ChangeTag change={file.change} />
        <span style={{ flex: 1 }} />
        {file.change === "modified" && (
          <button className="lnk" onClick={() => setMode(mode === "diff" ? "file" : "diff")}>{mode === "diff" ? "cały plik" : "zmiany"}</button>
        )}
        {text != null && <button className="lnk" onClick={() => copyText(text).then(() => toast("Skopiowano", 1500))}>kopiuj</button>}
        <button className="lnk" onClick={onClose}>zamknij</button>
      </div>
      {res.error && <Notice tone="neg" style={{ margin: 8 }}>{res.error}</Notice>}
      {!r && !res.error && <div style={{ padding: 8 }}><Skeleton h={160} /></div>}
      {r && "status" in r && (
        <Notice style={{ margin: 8 }}>
          {r.status === 415 ? "Plik binarny: bez podglądu." : r.status === 413 ? "Plik za duży do podglądu (limit 200 KiB)."
            : mode === "diff" ? "Porównanie z zatwierdzoną wersją jest niedostępne." : "Nie znaleziono pliku."}
        </Notice>
      )}
      {mode === "file" && text != null && (
        <pre tabIndex={0}><span className="in">{lines.map((l, k) => <span key={k} className="l">{l || " "}</span>)}</span></pre>
      )}
      {diff && (
        <pre tabIndex={0} aria-label={`Zmiany w ${file.path}`}>
          <span className="in">
            {diff.rows.map((row, k) => (
              <span key={k} className={`d ${row.kind}`}>
                {row.kind === "hunk" || row.kind === "note" ? row.text : (
                  <><i>{row.old ?? ""}</i><i>{row.new ?? ""}</i><b>{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</b>{row.text || " "}</>
                )}
              </span>
            ))}
            {!diff.rows.length && <span className="d note">Bez różnic w treści.</span>}
          </span>
        </pre>
      )}
    </div>
  );
}

function Runs({ id, kind, nonce }: { id: string; kind: string; nonce: number }) {
  const { slug } = useShell();
  const [n, setN] = useState(0);
  const r = useAsync(() => getConnectorRuns(id, 20), [id, nonce, n]);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const runs = r.data ?? [];
  const fetch = kind === "fetch";
  const cols = fetch ? 5 : 4;
  const toggle = (rid: number) => setOpen((s) => { const x = new Set(s); if (x.has(rid)) x.delete(rid); else x.add(rid); return x; });
  return (
    <>
      <Kick right={<><Tag>ostatnie {runs.length}</Tag><span className="spacer" /><button className="btn sm" onClick={() => setN((x) => x + 1)} disabled={r.loading}>Odśwież</button></>}>Przebiegi</Kick>
      {r.error && <Notice tone="neg">{r.error}</Notice>}
      <div className="scroll">
        <table>
          <thead><tr><th>Kiedy</th><th>Polecenie</th><th>Wynik</th><th className="num">Rekordy</th>{fetch && <th className="num">Hosty odrzucone</th>}</tr></thead>
          <tbody>
            {runs.map((x: ConnectorRun) => {
              const other = x.profile && x.profile !== slug;
              const details = !!x.error_kind || (!!x.stderr_tail && x.outcome !== "ok");
              const dur = x.duration_ms == null ? "" : x.duration_ms >= 1000 ? `${(x.duration_ms / 1000).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} s` : `${x.duration_ms} ms`;
              const hosts = x.denied_hosts ?? [];
              return [
                <tr key={x.id} className={other ? "muted" : undefined} title={other ? `profil ${x.profile}` : undefined}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(x.started_at)}{dur && <span className="fhint"> · {dur}</span>}</td>
                  <td><code>{x.command}</code></td>
                  <td>
                    <Tag tone={OUTCOME_TONE[x.outcome]}>{OUTCOME_LABEL[x.outcome] ?? x.outcome}</Tag>
                    {x.error_kind && <span className="fhint"> {kindShort(x.error_kind)}</span>}
                    {details && <> · <button className="lnk" style={{ fontSize: 12 }} aria-expanded={open.has(x.id)} onClick={() => toggle(x.id)}>Szczegóły</button></>}
                  </td>
                  <td className="num">{x.records ? x.records : x.outcome === "ok" ? (x.records ?? 0) : "-"}</td>
                  {fetch && (
                    <td className="num">{hosts.length ? <span title={hosts.join(", ")} style={{ color: "var(--warn)" }}>{hosts.length}</span> : <span className="muted">-</span>}</td>
                  )}
                </tr>,
                open.has(x.id) && (
                  <tr key={`${x.id}-d`}><td colSpan={cols}>
                    <RunError kind={x.error_kind ?? "internal"} stderr={x.stderr_tail} open style={{ margin: "4px 0" }} />
                  </td></tr>
                ),
              ];
            })}
            {!r.loading && !runs.length && !r.error && <tr><td colSpan={cols} className="muted">Jeszcze nie uruchomiony.</td></tr>}
            {r.loading && !runs.length && <tr><td colSpan={cols} className="muted">Wczytuję…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="foot">Ostatnie 20 z 500 zapisanych · stderr tylko tutaj, nigdy u agenta.</div>
    </>
  );
}
