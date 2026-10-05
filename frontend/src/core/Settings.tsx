// Ustawienia: sticky section nav (scroll-spy) + stacked cards. Profile fields save
// with Zapisz; switches and radios save on change with a toast.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAsync } from "../hooks";
import { parseServerTime, serverDate } from "../time";
import { Code, copyText, Notice, RadioList, Seg, Switch, Tag, useToast } from "../ui";
import {
  ApiError, getMcpCalls, getMcpInfo, getSetup, getSystem, mcpAddCommand, type McpCall, type ModuleInfo, patchProfile, postRelocationAck, postWorker, type Privacy,
  putProfileModules, type ProfileModule, type WorkerInfo,
} from "./api";
import { moduleDef, orderModules } from "./registry";
import { describeJob, errorText, relocationParts } from "./messages";
import { stepsTag } from "./SetupPage";
import { useShell } from "./context";
import type { ThemePref } from "./theme";
import { serialSaver } from "./util";
import { CURRENCIES, PRIVACY_OPTIONS } from "./Wizard";
import {
  changesToast, needsForce, outdatedLabel, PROPOSAL_NOTE, ROUTINE_PERMISSIONS_HINT, ROUTINE_PERMISSIONS_LABEL, TRANSLOCATED_TEXT, workspaceErrorText, workspaceSummary,
} from "./workspace";
import { getWorkspace, postWorkspace } from "./workspaceApi";
import { InvestmentsStrategySettings } from "../modules/investments/v2/StrategySettings";

const SECTIONS: [id: string, label: string][] = [
  ["profile", "Profil"], ["modules", "Moduły"], ["agent", "Agent AI (MCP)"], ["data", "Dane"],
  ["worker", "Praca w tle"], ["secrets", "Sekrety"], ["app", "Aplikacja"],
];

export function Settings({ section, theme, setTheme }: { section?: string; theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const [active, setActive] = useState(section && SECTIONS.some(([id]) => id === section) ? section : "profile");
  const root = useRef<HTMLDivElement>(null);

  // Jump to the requested section (e.g. from the SetupPage privacy notice).
  useEffect(() => {
    if (section) document.getElementById(`set-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);

  // Scroll-spy: the nav follows the card nearest the top of the viewport.
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(`set-${id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id.slice(4));
    }, { rootMargin: "-70px 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="settings" ref={root}>
      <nav aria-label="Sekcje ustawień">
        {SECTIONS.map(([id, label]) => (
          <button key={id} className={active === id ? "on" : ""} aria-current={active === id ? "true" : undefined}
            onClick={() => { setActive(id); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
            {label}
          </button>
        ))}
      </nav>
      <div>
        <ProfileSection />
        <ModulesSection />
        <AgentSection />
        <DataSection />
        <WorkerSection />
        <SecretsSection />
        <AppSection theme={theme} setTheme={setTheme} />
      </div>
    </div>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card chart-card" id={`set-${id}`} aria-labelledby={`set-${id}-h`}>
      <h2 id={`set-${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function ProfileSection() {
  const { slug, profile, profiles, reloadProfiles } = useShell();
  const toast = useToast();
  const [name, setName] = useState(profile.name);
  const [currency, setCurrency] = useState(profile.base_currency);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(profile.name); setCurrency(profile.base_currency); }, [profile.name, profile.base_currency]);

  const dirty = name.trim() !== profile.name || currency !== profile.base_currency;
  const save = async () => {
    const n = name.trim();
    if (!n) { setErr("Podaj nazwę profilu."); return; }
    if (profiles.some((p) => p.slug !== slug && p.name.trim().toLowerCase() === n.toLowerCase())) {
      setErr("Profil o tej nazwie już istnieje."); return;
    }
    setBusy(true); setErr(null);
    try {
      await patchProfile(slug, { name: n, base_currency: currency });
      await reloadProfiles();
      toast("Zapisano");
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Card id="profile" title="Profil">
      <div className="kv">
        <label className="k" htmlFor="set-name">Nazwa</label>
        <span className="v"><input id="set-name" value={name} maxLength={40} style={{ width: 220 }} onChange={(e) => setName(e.target.value)} /></span>
        <label className="k" htmlFor="set-cur">Waluta bazowa</label>
        <span className="v">
          <select id="set-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([...CURRENCIES, profile.base_currency])].map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="hint">inne waluty osobno, bez przeliczania</span>
        </span>
        <span className="k">Identyfikator</span>
        <span className="v"><code>{slug}</code><span className="hint">w poleceniach CLI i MCP (<code>--profile {slug}</code>)</span></span>
      </div>
      {err && <Notice tone="neg" style={{ margin: "14px 0 0" }}>{err}</Notice>}
      <div className="controls" style={{ margin: "16px 0 0" }}>
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>Zapisz</button>
      </div>
    </Card>
  );
}

/** Ids to enable when turning `id` on/off, honouring depends_on in both directions. */
function nextEnabled(id: string, on: boolean, enabled: Set<string>, all: ModuleInfo[]): string[] {
  const next = new Set(enabled);
  const add = (x: string) => { if (next.has(x)) return; next.add(x); all.find((m) => m.id === x)?.depends_on.forEach(add); };
  const drop = (x: string) => { next.delete(x); all.forEach((m) => { if (next.has(m.id) && m.depends_on.includes(x)) drop(m.id); }); };
  if (on) { next.delete(id); add(id); } else drop(id);
  return orderModules(all).map((m) => m.id).filter((x) => next.has(x));
}

function ModulesSection() {
  const { slug, profile, modules, reloadProfiles } = useShell();
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const server = new Set(profile.modules.filter((m) => m.enabled).map((m) => m.id));
  // The PUT replaces the whole module set, so toggles are optimistic and serialized:
  // `wanted` is the latest set the user asked for (shown at once), the saver sends one
  // PUT at a time and always ends with that latest set (a quick second toggle never
  // reverts the first). Back to the server's view once the saves and reload are done.
  const [wanted, setWanted] = useState<ReadonlySet<string> | null>(null);
  const wantedRef = useRef<ReadonlySet<string> | null>(null);
  const live = useRef({ reloadProfiles, toast });
  live.current = { reloadProfiles, toast };
  const [saver] = useState(() => serialSaver<string[]>(
    (ids) => putProfileModules(slug, ids),
    async (error) => {
      if (error) setErr((error as Error).message);
      await live.current.reloadProfiles();
      if (saver.busy) return; // a newer toggle is being saved; its own idle call finishes up
      wantedRef.current = null;
      setWanted(null);
      if (!error) live.current.toast("Zapisano");
    },
  ));
  const enabled = wanted ?? server;

  const toggle = (id: string, on: boolean) => {
    setErr(null);
    const ids = nextEnabled(id, on, new Set(wantedRef.current ?? server), modules);
    wantedRef.current = new Set(ids);
    setWanted(wantedRef.current);
    saver.push(ids);
  };

  return (
    <Card id="modules" title="Moduły">
      {orderModules(modules).map((m) => {
        const pm = profile.modules.find((x) => x.id === m.id);
        return (
          <ModuleRow key={m.id} info={m} on={enabled.has(m.id)} pm={pm}
            onToggle={(on) => toggle(m.id, on)} />
        );
      })}
      {err && <Notice tone="neg" style={{ margin: "10px 0 0" }}>Nie udało się zapisać modułów: {err}</Notice>}
    </Card>
  );
}

function ModuleRow({ info, on, pm, onToggle }: { info: ModuleInfo; on: boolean; pm?: ProfileModule; onToggle: (on: boolean) => void }) {
  const { slug, modules, go } = useShell();
  const def = moduleDef(info.id, modules);
  const pending = on && !!pm?.enabled && pm?.setup_state !== "ready";
  const { data } = useAsync(
    () => (pending ? getSetup(slug, info.id) : Promise.resolve(null)),
    [slug, info.id, pending, pm?.setup_state],
  );
  return (
    <div className="row">
      <Switch on={on} disabled={!info.available} label={`Moduł ${def.name}`} onChange={onToggle}
        title={!info.available ? "Wkrótce" : undefined} />
      <div className="grow">
        <div className="t">
          {def.name}
          {!info.available ? <Tag>wkrótce</Tag> : on ? stepsTag(data, pm?.setup_state) : null}
        </div>
        {/* "dane zachowane" only when the switched-off module actually holds data for this profile */}
        <div className="d">{!on && pm && info.available && pm.setup_state !== "empty" ? `${def.short} · wyłączony, dane zachowane` : def.short}</div>
      </div>
      {pending && <button className="lnk" onClick={() => go({ kind: "setup", module: info.id })}>Konfiguracja →</button>}
    </div>
  );
}

const desktopJson = (slug: string) =>
  `{\n  "mcpServers": {\n    "finanse-${slug}": {\n      "command": "finanse",\n      "args": ["mcp", "--profile", "${slug}"]\n    }\n  }\n}`;

function AgentSection() {
  const { slug, profile, reloadProfiles } = useShell();
  // Server-built lines (absolute path of the bundled binary in the packaged app); local fallback.
  const { data: mcp } = useAsync(() => getMcpInfo(slug).catch(() => null), [slug]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const change = async (v: Privacy) => {
    if (v === profile.mcp_privacy) return;
    setBusy(true); setErr(null);
    try {
      await patchProfile(slug, { mcp_privacy: v });
      await reloadProfiles();
      toast("Zapisano");
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Card id="agent" title="Agent AI (MCP)">
      <RadioList<Privacy> name="set-privacy" value={profile.mcp_privacy} onChange={change} disabled={busy}
        options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, title: o.title, desc: o.desc, tooltip: o.example, tag: o.tag ? <Tag>domyślny</Tag> : undefined }))} />
      {err && <Notice tone="neg">Nie udało się zapisać poziomu: {err}</Notice>}
      <Notice tone="info">{PROPOSAL_NOTE}</Notice>
      <WorkspacePanel />
      {mcp?.translocated && <Notice tone="warn">{TRANSLOCATED_TEXT}</Notice>}
      <div className="kv" style={{ marginTop: 14 }}>
        <span className="k">Claude Code</span>
        <span className="v block"><Code cmd={mcp?.claude_mcp_add ?? mcpAddCommand(slug)} /></span>
        <span className="k">Claude Desktop</span>
        <span className="v block">
          <Code cmd={mcp?.claude_desktop
            ? JSON.stringify({ mcpServers: { [mcp.server_name]: mcp.claude_desktop } }, null, 2)
            : desktopJson(slug)} multiline />
        </span>
      </div>
      {profile.modules.some((m) => m.id === "investments" && m.enabled) && <InvestmentsStrategySettings />}
      <AuditLog />
    </Card>
  );
}

// ---- Agent AI: the profile's agent workspace (GET/POST /api/p/{slug}/workspace) ---------------

function WorkspacePanel() {
  const { slug, profile } = useShell();
  const toast = useToast();
  const enabledKey = profile.modules.filter((m) => m.enabled).map((m) => m.id).join(",");
  // A module or privacy change updates an existing workspace on the server: re-read the status then.
  const { data: ws, error, loading, reload } = useAsync(() => getWorkspace(slug), [slug, enabledKey, profile.mcp_privacy]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState("");
  const investments = profile.modules.some((m) => m.id === "investments" && m.enabled);
  const summary = workspaceSummary(ws);

  const run = async (body: { path?: string | null; force?: boolean; routine_permissions?: boolean }) => {
    const creating = !ws?.exists;
    setBusy(true); setErr(null);
    try {
      const res = await postWorkspace(slug, body);
      toast(changesToast(res, creating));
      setEditing(false);
      reload();
    } catch (e) { setErr(workspaceErrorText(e)); } finally { setBusy(false); }
  };
  const newPath = editing ? path.trim() || null : null;

  return (
    <div style={{ margin: "14px 0 0" }}>
      <div className="controls" style={{ margin: "0 0 6px" }}>
        <strong style={{ fontSize: 14 }} title="CLAUDE.md, .mcp.json, uprawnienia i skille modułów. Dane tylko przez MCP.">Workspace agenta</strong>
        {ws && <Tag tone={summary.tone}>{summary.text}</Tag>}
        <span className="spacer" />
        {ws?.exists && ws.mcp_command_stale && <Tag tone="warn" title="Serwer MCP w .mcp.json wskazuje poprzednią lokalizację aplikacji. Aktualizuj zapisze nową.">MCP: stara ścieżka</Tag>}
        {ws?.exists && (
          <button className="btn" onClick={() => run({})} disabled={busy}
            title="Odświeża CLAUDE.md, .mcp.json, uprawnienia i skille; Twoje pliki zostają.">{busy ? "Aktualizuję…" : "Aktualizuj"}</button>
        )}
        {ws && !ws.exists && (
          <button className="btn primary" onClick={() => run({ path: newPath })} disabled={busy}>{busy ? "Tworzę…" : "Utwórz"}</button>
        )}
      </div>
      {error && <Notice tone="neg">Nie udało się sprawdzić workspace: {error}</Notice>}
      {loading && !ws && <div className="muted" style={{ fontSize: 13 }}>Sprawdzam…</div>}
      {ws && (
        <div className="kv">
          <span className="k">Folder</span>
          <span className="v">
            <code>{ws.path}</code>
            {ws.custom && <Tag>własny</Tag>}
            <button className="lnk" onClick={() => { setEditing(!editing); setPath(ws.path); }} disabled={busy}>
              {editing ? "Anuluj" : "Zmień folder"}
            </button>
          </span>
          {editing && (
            <>
              <span className="k"><label htmlFor="set-ws-path">Nowy folder</label></span>
              <span className="v">
                <input id="set-ws-path" value={path} autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 220 }}
                  onChange={(e) => setPath(e.target.value)} disabled={busy} />
                {ws.exists && (
                  <button className="btn" onClick={() => run({ path: path.trim() })} disabled={busy || !path.trim()}>Przenieś</button>
                )}
              </span>
            </>
          )}
          {ws.exists && (
            <>
              <span className="k">Otwórz w Claude Code</span>
              <span className="v block"><Code cmd={ws.claude_command} /></span>
              <span className="k">Zarządzane</span>
              <span className="v" style={{ fontSize: 13 }}>
                finanse {ws.managed_version ?? "-"} · skille: {ws.skills.filter((x) => x.state !== "extra").map((x) => `/${x.name}`).join(", ") || "brak"}
              </span>
            </>
          )}
        </div>
      )}
      {ws?.conflict && <Notice tone="neg" style={{ margin: "10px 0 0" }}>Ten folder jest workspace innego profilu. Wybierz inny folder.</Notice>}
      {ws?.exists && ws.outdated.length > 0 && (
        <Notice tone="warn" style={{ margin: "10px 0 0" }} action={needsForce(ws)
          ? <button className="btn" onClick={() => run({ force: true })} disabled={busy} title="Twoja wersja trafi do .claude/finanse-backup/.">Zastąp zmienione</button>
          : undefined}>
          Do aktualizacji:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {ws.outdated.map((i) => <li key={`${i.kind}:${i.name}`}>{outdatedLabel(i)}</li>)}
          </ul>
        </Notice>
      )}
      {investments && ws && (
        <div style={{ margin: "12px 0 0" }}>
          <div className="controls" style={{ margin: "0 0 4px", fontSize: 13 }}>
            <Switch on={ws.routine_permissions} label={ROUTINE_PERMISSIONS_LABEL} disabled={busy || !ws.exists}
              title={!ws.exists ? "Najpierw utwórz workspace" : undefined} onChange={(v) => run({ routine_permissions: v })} />
            <span>{ROUTINE_PERMISSIONS_LABEL}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>{ROUTINE_PERMISSIONS_HINT}</div>
          {ws.exists && (
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="k" title="Rutyny w chmurze nie widzą serwera MCP na tym komputerze.">Rutyna (lokalna)</span>
              <span className="v"><code>/market-research rutyna</code><span className="hint">Claude › Code › Routines › Local · sobota 07:00 · ten folder</span></span>
              <span className="k">Z terminala</span>
              <span className="v block"><Code cmd={ws.routine_command} /></span>
            </div>
          )}
        </div>
      )}
      {err && <Notice tone="neg" style={{ margin: "10px 0 0" }}>Nie udało się zapisać workspace. {err}</Notice>}
    </div>
  );
}

// ---- Agent AI: audit log of MCP calls (track M: GET /api/p/{slug}/mcp/calls) -----------------

const OUTCOME: Record<string, [string, "pos" | "neg" | "warn" | undefined]> = {
  ok: ["ok", "pos"], error: ["błąd", "neg"], refused: ["odmowa", "warn"],
};
const PRIVACY_SHORT: Record<string, string> = { strict: "ścisły", amounts: "z kwotami" };
const callTime = (c: McpCall) => c.called_at ?? c.at ?? c.created_at ?? null;
const timeFmt = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

function AuditLog() {
  const { slug } = useShell();
  const { data, error, loading, reload } = useAsync(() => getMcpCalls(slug, 50), [slug]);
  const calls = data ?? [];
  const week = Date.now() - 7 * 86400000;
  const recent = calls.filter((c) => { const t = callTime(c); return t ? parseServerTime(t) >= week : false; }).length;
  return (
    <>
      <div className="controls" style={{ margin: "14px 0 6px" }}>
        <strong style={{ fontSize: 14 }}>Dziennik wywołań</strong>
        <Tag>ostatnie 7 dni · {data === null ? 0 : recent}</Tag>
        <span className="spacer" />
        {data !== null && <button className="btn" onClick={reload} disabled={loading}>Odśwież</button>}
      </div>
      {error && <Notice tone="neg">Nie udało się pobrać dziennika: {error}</Notice>}
      <div className="scroll tall">
        <table>
          <thead><tr><th>Czas</th><th>Narzędzie</th><th>Argumenty</th><th>Poziom</th><th>Wynik</th></tr></thead>
          <tbody>
            {calls.map((c, k) => {
              const t = callTime(c);
              const outcome = c.outcome ?? c.status ?? c.result ?? "";
              const [label, tone] = OUTCOME[outcome] ?? [outcome || "-", undefined];
              const args = c.args ? Object.keys(c.args).join(", ") : c.args_summary ?? c.arguments ?? "";
              const privacy = c.privacy ?? c.privacy_level ?? "";
              return (
                <tr key={c.id ?? k}>
                  <td style={{ whiteSpace: "nowrap" }}>{serverDate(t) ? timeFmt.format(serverDate(t)!) : "-"}</td>
                  <td><code>{c.tool}</code></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{args || "-"}</td>
                  <td>{PRIVACY_SHORT[privacy] ?? privacy ?? "-"}</td>
                  <td><Tag tone={tone}>{label}</Tag>{c.error_kind ? <span className="hint"> {c.error_kind}</span> : null}{c.duration_ms != null ? <span className="hint"> · {c.duration_ms} ms</span> : null}</td>
                </tr>
              );
            })}
            {!loading && !calls.length && (
              <tr><td colSpan={5} className="muted">{data === null ? "Dziennik niedostępny." : "Brak wywołań."}</td></tr>
            )}
            {loading && !calls.length && <tr><td colSpan={5} className="muted">Wczytuję…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="foot">Nazwy argumentów, nigdy wartości.</div>
    </>
  );
}

function DataSection() {
  const { system } = useShell();
  const toast = useToast();
  return (
    <Card id="data" title="Dane">
      <div className="kv">
        <span className="k">Katalog danych</span>
        <span className="v">
          <code style={{ fontSize: 13, overflowWrap: "anywhere" }}>{system?.data_dir ?? "-"}</code>
          {system?.data_dir && <button className="btn" onClick={() => copyText(system.data_dir).then(() => toast("Skopiowano", 1500))}>Kopiuj</button>}
        </span>
        <span className="k">Kopie zapasowe</span>
        <span className="v"><span className="hint" style={{ fontSize: 13 }}>podkatalog <code>backups</code> w katalogu danych</span></span>
      </div>
      {system?.legacy_db_detected ? (
        <Notice tone="warn" style={{ margin: "14px 0 0" }}>
          Stara baza: <code>{system.legacy_db_path || "data/finanse.db"}</code>. Zamknij aplikację i uruchom:
          <Code cmd="finanse migrate-data" />
        </Notice>
      ) : null}
    </Card>
  );
}

// ---- Praca w tle (track W: worker status in /api/system, install / uninstall / run) ---------

const JOB_LABEL: Record<string, [string, string]> = {
  "investments.daily": ["Sprawdzenie reguł", "Inwestycje"], "budget.sync": ["Synchronizacja banków", "Budżet"],
  notifications: ["Powiadomienia", "wszystkie"], digest: ["Podsumowanie tygodnia", "wszystkie"],
};
const JOB_STATUS: Record<string, [string, "pos" | "neg" | "warn" | undefined]> = {
  ok: ["ok", "pos"], partial: ["częściowy", "warn"], failed: ["błąd", "neg"], skipped: ["pominięte", undefined],
};
const when = (iso: string | null | undefined) => { const t = serverDate(iso); return t ? timeFmt.format(t) : "-"; };

function WorkerSection() {
  const { system, profile, slug } = useShell();
  const toast = useToast();
  const [w, setW] = useState<WorkerInfo | null>(system?.worker ?? null);
  const [time, setTime] = useState(system?.worker?.schedule ?? "07:30");
  const [busy, setBusy] = useState<null | "install" | "uninstall" | "run">(null);
  const [err, setErr] = useState<string | null>(null);
  const [acking, setAcking] = useState(false);
  // Fresh status on open (the shell loads /api/system once per page load).
  useEffect(() => {
    let alive = true;
    getSystem().then((s) => { if (alive) { setW(s.worker); setTime(s.worker?.schedule ?? "07:30"); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const known = !!w && "schedule" in w; // older servers: only installed + last_run
  const supported = w?.supported !== false;
  const act = async (action: "install" | "uninstall" | "run", body: { time?: string } = {}) => {
    setBusy(action); setErr(null);
    try {
      const r = await postWorker(action, body);
      if (r.worker) setW(r.worker);
      if (action === "run") toast(`Przebieg zakończony · ${JOB_STATUS[r.run?.status ?? ""]?.[0] ?? r.run?.status ?? "ok"}`, 3000);
      else toast(action === "install" ? "Praca w tle zainstalowana" : "Praca w tle odinstalowana");
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setErr(status === 409 ? "Praca w tle właśnie działa - spróbuj za chwilę." : status === 501 ? "Ten system nie ma obsługiwanego harmonogramu zadań." : errorText(e));
    } finally { setBusy(null); }
  };
  const on = (id: string) => profile.modules.some((m) => m.id === id && m.enabled);
  const schedule = w?.schedule ? `codziennie ${w.schedule}` : "codziennie";
  const jobs = w?.jobs?.length ? w.jobs : [
    ...(on("investments") ? [{ job: "investments.daily", module: "investments", status: "", detail: null }] : []),
    ...(on("budget") ? [{ job: "budget.sync", module: "budget", status: "", detail: null }] : []),
    { job: "notifications", module: null, status: "", detail: null },
    { job: "digest", module: null, status: "", detail: null },
  ];
  const reloc = relocationParts(w?.relocation);
  const ackMcp = async () => {
    setAcking(true); setErr(null);
    try {
      const r = await postRelocationAck();
      if (r.worker) setW(r.worker);
    } catch (e) { setErr(`Nie zapisano: ${errorText(e)}`); } finally { setAcking(false); }
  };
  return (
    <Card id="worker" title="Praca w tle">
      {reloc.worker && (
        <Notice tone="warn" style={{ margin: "0 0 10px" }}
          action={<button className="btn primary" disabled={!known || busy != null} onClick={() => act("install", { time: w?.schedule ?? time })}>{busy === "install" ? "Instaluję…" : "Zainstaluj ponownie"}</button>}>
          <b>{reloc.worker}.</b>
        </Notice>
      )}
      {reloc.mcp && (
        <Notice tone="warn" style={{ margin: "0 0 10px" }}
          action={<button className="btn" disabled={acking} title="Serwer MCP dodany ponownie w Claude Code / Claude Desktop" onClick={ackMcp}>{acking ? "Zapisuję…" : "Gotowe"}</button>}>
          {reloc.mcp}
        </Notice>
      )}
      <div className="row" style={{ paddingTop: 0 }}>
        <Switch on={!!w?.installed} disabled={!known || !supported || busy != null} label={`Codziennie o ${w?.schedule ?? time}`}
          title={!known ? "Serwer nie obsługuje jeszcze instalacji z aplikacji" : !supported ? "Ten system nie ma obsługiwanego harmonogramu zadań" : undefined}
          onChange={(v) => act(v ? "install" : "uninstall", v ? { time } : {})} />
        <div className="grow">
          <div className="t">Codziennie o {w?.schedule ?? time} {w?.installed ? <Tag tone="pos">działa</Tag> : <Tag>nie zainstalowano</Tag>}</div>
          <div className="d">
            {w?.platform === "launchd" || !w?.platform ? "launchd" : w.platform} · {schedule}
            {w?.installed && w.next_run ? ` · następny przebieg ${when(w.next_run)}` : ""}
            {w?.last_run ? ` · ostatni ${when(w.last_run)}${w.last_status ? ` (${JOB_STATUS[w.last_status]?.[0] ?? w.last_status})` : ""}` : " · jeszcze nie uruchomiono"}
          </div>
        </div>
        <button className="btn" disabled={!known || busy != null} onClick={() => act("run")}
          title="Jeden przebieg teraz: reguły inwestycji, synchronizacja banków (jeśli skonfigurowana), powiadomienia">
          {busy === "run" ? "Uruchamiam…" : "Uruchom teraz"}
        </button>
      </div>
      {known && (
        <div className="kv" style={{ margin: "10px 0" }}>
          <label className="k" htmlFor="set-worker-time">Godzina</label>
          <span className="v">
            <input id="set-worker-time" type="time" title="Czas lokalny. Uśpiony Mac nadrobi po wybudzeniu, wyłączony pominie dzień." value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 110 }} />
            {w?.installed && time !== w.schedule && <button className="btn primary" disabled={busy != null} onClick={() => act("install", { time })}>Zapisz</button>}
          </span>
          {w?.log_path && <>
            <span className="k">Dziennik</span>
            <span className="v"><code style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{w.log_path}</code>
              <button className="btn" onClick={() => copyText(w.log_path!).then(() => toast("Skopiowano", 1500))}>Kopiuj</button></span>
          </>}
        </div>
      )}
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="scroll">
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Zadanie</th><th>Moduł</th><th>Harmonogram</th><th>Ostatnio</th><th>Status</th></tr></thead>
          <tbody>
            {jobs.map((j) => {
              const [label, mod] = JOB_LABEL[j.job] ?? [j.job, j.module ?? "-"];
              const [st, tone] = JOB_STATUS[j.status] ?? [null, undefined];
              const sched = j.job === "digest" ? "dzień podsumowania ze strategii" : j.job === "budget.sync" ? `${schedule} (limit banku)` : schedule;
              return (
                <tr key={j.job} className={st ? "" : "muted"}>
                  <td>{label}</td><td>{mod}</td><td>{sched}</td><td>{"last_run" in j && j.last_run ? when(j.last_run) : st ? when(w?.last_run) : "-"}</td>
                  <td>{st ? <><Tag tone={tone}>{st}</Tag>{describeJob(j) ? <span className="hint"> {j.profile && j.profile !== slug ? `${j.profile}: ` : ""}{describeJob(j)}</span> : null}</> : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="foot">Natychmiast tylko sygnały „do działania", reszta w podsumowaniu tygodnia.</div>
    </Card>
  );
}

function presence(v: boolean | undefined, yes: string): ReactNode {
  if (v === undefined) return <Tag title="Serwer nie podaje tego stanu">stan nieznany</Tag>;
  return v ? <Tag tone="pos">{yes}</Tag> : <Tag>brak</Tag>;
}

function SecretsSection() {
  const { system } = useShell();
  const s = system?.secrets;
  return (
    <Card id="secrets" title="Sekrety">
      <div className="row">
        <div className="grow">
          <div className="t">Klucz API Anthropic {presence(s?.anthropic, "w pęku kluczy")}</div>
          <div className="d">pęk kluczy · kategoryzacja (Budżet), backend anthropic</div>
          <Code cmd="finanse secrets set anthropic" />
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">Enable Banking · klucz prywatny {presence(s?.enable_banking_key, "w katalogu danych")}</div>
          <div className="d">plik .pem w katalogu danych · sesje per bank w bazie</div>
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">Token API aplikacji</div>
          <div className="d">losowy przy starcie · tylko 127.0.0.1</div>
        </div>
      </div>
      <div className="foot">Sekrety nie trafiają do logów, eksportów ani do agenta AI.</div>
    </Card>
  );
}

function AppSection({ theme, setTheme }: { theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const { system } = useShell();
  return (
    <Card id="app" title="Aplikacja">
      <div className="kv">
        <span className="k">Motyw</span>
        <span className="v">
          <Seg<ThemePref> items={[["Systemowy", "system"], ["Jasny", "light"], ["Ciemny", "dark"]]} value={theme} onChange={setTheme} />
          <span className="hint">zapisany w tej przeglądarce</span>
        </span>
        <span className="k">Wersja</span>
        <span className="v">{system?.version ?? "-"}</span>
      </div>
    </Card>
  );
}
