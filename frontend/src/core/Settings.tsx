// Ustawienia: sticky section nav (scroll-spy) + stacked cards. Profile fields save
// with Zapisz; switches and radios save on change with a toast.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAsync } from "../hooks";
import { ck } from "../swr";
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
import { CURRENCIES } from "./Wizard";
import { PRIVACY } from "./Wizard.strings.ts";
import {
  changesToast, needsForce, outdatedLabel, workspaceErrorText, workspaceSummary,
} from "./workspace";
import { WS } from "./workspace.strings.ts";
import { getWorkspace, postWorkspace } from "./workspaceApi";
import { ConnectorsSection } from "./ConnectorsSection";
import { LANG_NAME, LANGS, type Lang, setLanguage, storedLang } from "../i18n";
import { JOB_LABEL as JOB_LABELS, JOB_STATUS as JOB_STATUSES, MIGRATION_STEP as MIGRATION_STEPS, OUTCOME as OUTCOMES, PRIVACY_SHORT as PRIVACY_SHORTS, S, SECTION } from "./Settings.strings.ts";
import { C } from "../common.strings.ts";
import { intlLocale } from "../i18n.ts";
import { InvestmentsStrategySettings } from "../modules/investments/v2/StrategySettings";

const SECTIONS = ["profile", "modules", "agent", "connectors", "data", "worker", "secrets", "app"] as const;

// A write that changes /api/system bumps this and Praca w tle re-reads the status: a workspace update rewrites
// .mcp.json and clears `relocation.mcp`, the ack and a worker install change it too (F7 FIX2 A5).
const SystemChanged = createContext<{ tick: number; changed: () => void }>({ tick: 0, changed: () => {} });

export function Settings({ section, theme, setTheme }: { section?: string; theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const [active, setActive] = useState(section && SECTIONS.some((id) => id === section) ? section : "profile");
  const root = useRef<HTMLDivElement>(null);
  const [sysTick, setSysTick] = useState(0);
  const systemChanged = useCallback(() => setSysTick((n) => n + 1), []);

  // Jump to the requested section (e.g. from the SetupPage privacy notice).
  useEffect(() => {
    if (section) document.getElementById(`set-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);

  // Scroll-spy: the nav follows the card nearest the top of the viewport.
  useEffect(() => {
    const els = SECTIONS.map((id) => document.getElementById(`set-${id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id.slice(4));
    }, { rootMargin: "-70px 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="settings" ref={root}>
      <nav aria-label={S.sectionsNav}>
        {SECTIONS.map((id) => (
          <button key={id} className={active === id ? "on" : ""} aria-current={active === id ? "true" : undefined}
            onClick={() => { setActive(id); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
            {SECTION[id]}
          </button>
        ))}
      </nav>
      <SystemChanged.Provider value={{ tick: sysTick, changed: systemChanged }}>
        <div>
          <ProfileSection />
          <ModulesSection />
          <AgentSection />
          <ConnectorsSection />
          <DataSection />
          <WorkerSection />
          <SecretsSection />
          <AppSection theme={theme} setTheme={setTheme} />
        </div>
      </SystemChanged.Provider>
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
  const { slug, profile, profiles, reloadProfiles, refresh } = useShell();
  const toast = useToast();
  const [name, setName] = useState(profile.name);
  const [currency, setCurrency] = useState(profile.base_currency);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(profile.name); setCurrency(profile.base_currency); }, [profile.name, profile.base_currency]);

  const dirty = name.trim() !== profile.name || currency !== profile.base_currency;
  const save = async () => {
    const n = name.trim();
    if (!n) { setErr(S.nameRequired); return; }
    if (profiles.some((p) => p.slug !== slug && p.name.trim().toLowerCase() === n.toLowerCase())) {
      setErr(S.nameTaken); return;
    }
    setBusy(true); setErr(null);
    try {
      const currencyChanged = currency !== profile.base_currency;
      await patchProfile(slug, { name: n, base_currency: currency });
      await reloadProfiles();
      // Every figure in the base currency (summary, net worth, month close, investments) is cached in the old one:
      // forget the cache and re-read the shell's data (F7 FIX2 audit).
      if (currencyChanged) refresh?.();
      toast(C.saved);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Card id="profile" title={SECTION.profile}>
      <div className="kv">
        <label className="k" htmlFor="set-name">{S.name}</label>
        <span className="v"><input id="set-name" value={name} maxLength={40} style={{ width: 220 }} onChange={(e) => setName(e.target.value)} /></span>
        <label className="k" htmlFor="set-cur">{S.baseCurrency}</label>
        <span className="v">
          <select id="set-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {[...new Set([...CURRENCIES, profile.base_currency])].map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="hint">{S.baseCurrencyHint}</span>
        </span>
        <span className="k">{S.slug}</span>
        <span className="v"><code>{slug}</code><span className="hint">{S.slugHint} (<code>--profile {slug}</code>)</span></span>
      </div>
      {err && <Notice tone="neg" style={{ margin: "14px 0 0" }}>{err}</Notice>}
      <div className="controls" style={{ margin: "16px 0 0" }}>
        <button className="btn primary" onClick={save} disabled={busy || !dirty}>{C.save}</button>
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
  const { slug, profile, modules, reloadProfiles, refresh } = useShell();
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const server = new Set(profile.modules.filter((m) => m.enabled).map((m) => m.id));
  // The PUT replaces the whole module set, so toggles are optimistic and serialized:
  // `wanted` is the latest set the user asked for (shown at once), the saver sends one
  // PUT at a time and always ends with that latest set (a quick second toggle never
  // reverts the first). Back to the server's view once the saves and reload are done.
  const [wanted, setWanted] = useState<ReadonlySet<string> | null>(null);
  const wantedRef = useRef<ReadonlySet<string> | null>(null);
  const live = useRef({ reloadProfiles, toast, refresh });
  live.current = { reloadProfiles, toast, refresh };
  const [saver] = useState(() => serialSaver<string[]>(
    (ids) => putProfileModules(slug, ids),
    async (error) => {
      if (error) setErr((error as Error).message);
      await live.current.reloadProfiles();
      if (saver.busy) return; // a newer toggle is being saved; its own idle call finishes up
      wantedRef.current = null;
      setWanted(null);
      // The month close carries the investments plan only while that module is on (and summaries follow the
      // module set): forget the cached views (F7 FIX2 audit).
      live.current.refresh?.();
      if (!error) live.current.toast(C.saved);
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
    <Card id="modules" title={SECTION.modules}>
      {orderModules(modules).map((m) => {
        const pm = profile.modules.find((x) => x.id === m.id);
        return (
          <ModuleRow key={m.id} info={m} on={enabled.has(m.id)} pm={pm}
            onToggle={(on) => toggle(m.id, on)} />
        );
      })}
      {err && <Notice tone="neg" style={{ margin: "10px 0 0" }}>{S.modulesSaveFailed(err)}</Notice>}
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
    { key: pending ? ck(slug, "setup", info.id) : undefined },
  );
  return (
    <div className="row">
      <Switch on={on} disabled={!info.available} label={S.moduleSwitch(def.name)} onChange={onToggle}
        title={!info.available ? S.soonTitle : undefined} />
      <div className="grow">
        <div className="t">
          {def.name}
          {!info.available ? <Tag>{S.soon}</Tag> : on ? stepsTag(data, pm?.setup_state) : null}
        </div>
        {/* "dane zachowane" only when the switched-off module actually holds data for this profile */}
        <div className="d">{!on && pm && info.available && pm.setup_state !== "empty" ? S.offDataKept(def.short) : def.short}</div>
      </div>
      {pending && <button className="lnk" onClick={() => go({ kind: "setup", module: info.id })}>{S.configure}</button>}
    </div>
  );
}

const desktopJson = (slug: string) =>
  `{\n  "mcpServers": {\n    "cashu-${slug}": {\n      "command": "cashu",\n      "args": ["mcp", "--profile", "${slug}"]\n    }\n  }\n}`;

function AgentSection() {
  const { slug, profile, reloadProfiles } = useShell();
  // Server-built lines (absolute path of the bundled binary in the packaged app); local fallback.
  const { data: mcp } = useAsync(() => getMcpInfo(slug), [slug], { key: ck(slug, "mcp-info") });
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const change = async (v: Privacy) => {
    if (v === profile.mcp_privacy) return;
    setBusy(true); setErr(null);
    try {
      await patchProfile(slug, { mcp_privacy: v });
      await reloadProfiles();
      toast(C.saved);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Card id="agent" title={SECTION.agent}>
      <RadioList<Privacy> name="set-privacy" label={PRIVACY.question} value={profile.mcp_privacy} onChange={change} disabled={busy}
        options={PRIVACY.options.map((o) => ({ value: o.value, title: o.title, desc: o.desc, tooltip: o.example }))} />
      <div className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>{PRIVACY.common}</div>
      {err && <Notice tone="neg">{S.privacySaveFailed(err)}</Notice>}
      <Notice tone="info">{WS.proposalNote}</Notice>
      <WorkspacePanel />
      {mcp?.translocated && <Notice tone="warn">{WS.translocated}</Notice>}
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
  const { data: ws, error, loading, reload } = useAsync(() => getWorkspace(slug), [slug, enabledKey, profile.mcp_privacy], { key: ck(slug, "workspace") });
  const system = useContext(SystemChanged);
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
      system.changed(); // a rewritten .mcp.json clears the moved-app MCP notice under Praca w tle
    } catch (e) { setErr(workspaceErrorText(e)); } finally { setBusy(false); }
  };
  const newPath = editing ? path.trim() || null : null;

  return (
    <div style={{ margin: "14px 0 0" }}>
      <div className="controls" style={{ margin: "0 0 6px" }}>
        <strong style={{ fontSize: 14 }} title={S.workspaceTitle}>{S.workspace}</strong>
        {ws && <Tag tone={summary.tone}>{summary.text}</Tag>}
        <span className="spacer" />
        {ws?.exists && ws.mcp_command_stale && <Tag tone="warn" title={S.mcpStaleTitle}>{S.mcpStale}</Tag>}
        {ws?.exists && (
          <button className="btn" onClick={() => run({})} disabled={busy}
            title={S.updateTitle}>{busy ? S.updating : S.update}</button>
        )}
        {ws && !ws.exists && (
          <button className="btn primary" onClick={() => run({ path: newPath })} disabled={busy}>{busy ? S.creating : S.create}</button>
        )}
      </div>
      {error && <Notice tone="neg">{S.workspaceCheckFailed(error)}</Notice>}
      {loading && !ws && <div className="muted" style={{ fontSize: 13 }}>{S.checking}</div>}
      {ws && (
        <div className="kv">
          <span className="k">{S.folder}</span>
          <span className="v">
            <code>{ws.path}</code>
            {ws.custom && <Tag>{S.customFolder}</Tag>}
            <button className="lnk" onClick={() => { setEditing(!editing); setPath(ws.path); }} disabled={busy}>
              {editing ? C.cancel : S.changeFolder}
            </button>
          </span>
          {editing && (
            <>
              <span className="k"><label htmlFor="set-ws-path">{S.newFolder}</label></span>
              <span className="v">
                <input id="set-ws-path" value={path} autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 220 }}
                  onChange={(e) => setPath(e.target.value)} disabled={busy} />
                {ws.exists && (
                  <button className="btn" onClick={() => run({ path: path.trim() })} disabled={busy || !path.trim()}>{S.move}</button>
                )}
              </span>
            </>
          )}
          {ws.exists && (
            <>
              <span className="k">{S.openInClaude}</span>
              <span className="v block"><Code cmd={ws.claude_command} /></span>
              <span className="k">{S.managed}</span>
              <span className="v" style={{ fontSize: 13 }}>
                cashU {ws.managed_version ?? "-"} · {S.skills}: {ws.skills.filter((x) => x.state !== "extra").map((x) => `/${x.name}`).join(", ") || S.none}
              </span>
            </>
          )}
        </div>
      )}
      {ws?.conflict && <Notice tone="neg" style={{ margin: "10px 0 0" }}>{S.folderConflict}</Notice>}
      {ws?.exists && ws.outdated.length > 0 && (
        <Notice tone="warn" style={{ margin: "10px 0 0" }} action={needsForce(ws)
          ? <button className="btn" onClick={() => run({ force: true })} disabled={busy} title={S.forceTitle}>{S.force}</button>
          : undefined}>
          {S.outdated}
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {ws.outdated.map((i) => <li key={`${i.kind}:${i.name}`}>{outdatedLabel(i)}</li>)}
          </ul>
        </Notice>
      )}
      {investments && ws && (
        <div style={{ margin: "12px 0 0" }}>
          <div className="controls" style={{ margin: "0 0 4px", fontSize: 13 }}>
            <Switch on={ws.routine_permissions} label={WS.routinePermissionsLabel} disabled={busy || !ws.exists}
              title={!ws.exists ? S.createWorkspaceFirst : undefined} onChange={(v) => run({ routine_permissions: v })} />
            <span>{WS.routinePermissionsLabel}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>{WS.routinePermissionsHint}</div>
          {ws.exists && (
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="k" title={S.routineTitle}>{S.routine}</span>
              <span className="v"><code>/market-research rutyna</code><span className="hint">{S.routineHint}</span></span>
              <span className="k">{S.fromTerminal}</span>
              <span className="v block"><Code cmd={ws.routine_command} /></span>
            </div>
          )}
        </div>
      )}
      {err && <Notice tone="neg" style={{ margin: "10px 0 0" }}>{S.workspaceSaveFailed(err)}</Notice>}
    </div>
  );
}

// ---- Agent AI: audit log of MCP calls (track M: GET /api/p/{slug}/mcp/calls) -----------------

const OUTCOME: Record<string, [string, "pos" | "neg" | "warn" | undefined]> = OUTCOMES;
const PRIVACY_SHORT: Record<string, string> = PRIVACY_SHORTS;
const callTime = (c: McpCall) => c.called_at ?? c.at ?? c.created_at ?? null;
const timeFmt = new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

function AuditLog() {
  const { slug } = useShell();
  const { data, error, loading, refreshing, reload } = useAsync(() => getMcpCalls(slug, 50), [slug], { key: ck(slug, "mcp-calls", 50) });
  const calls = data ?? [];
  const week = Date.now() - 7 * 86400000;
  const recent = calls.filter((c) => { const t = callTime(c); return t ? parseServerTime(t) >= week : false; }).length;
  return (
    <>
      <div className="controls" style={{ margin: "14px 0 6px" }}>
        <strong style={{ fontSize: 14 }}>{S.callLog}</strong>
        <Tag>{S.last7Days(data === null ? 0 : recent)}</Tag>
        <span className="spacer" />
        {data !== null && <button className="btn" onClick={reload} disabled={loading || refreshing}>{C.refresh}</button>}
      </div>
      {error && <Notice tone="neg">{S.callLogFailed(error)}</Notice>}
      <div className="scroll tall">
        <table>
          <thead><tr><th>{S.colTime}</th><th>{S.colTool}</th><th>{S.colArgs}</th><th>{S.colLevel}</th><th>{S.colResult}</th></tr></thead>
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
              <tr><td colSpan={5} className="muted">{data === null ? S.callLogUnavailable : S.noCalls}</td></tr>
            )}
            {loading && !calls.length && <tr><td colSpan={5} className="muted">{C.loading}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="foot">{S.argNamesOnly}</div>
    </>
  );
}

function DataSection() {
  const { system } = useShell();
  const toast = useToast();
  return (
    <Card id="data" title={SECTION.data}>
      <div className="kv">
        <span className="k">{S.dataDir}</span>
        <span className="v">
          <code style={{ fontSize: 13, overflowWrap: "anywhere" }}>{system?.data_dir ?? "-"}</code>
          {system?.data_dir && <button className="btn" onClick={() => copyText(system.data_dir).then(() => toast(S.copied, 1500))}>{S.copy}</button>}
        </span>
        <span className="k">{S.backups}</span>
        <span className="v"><span className="hint" style={{ fontSize: 13 }}>{S.backupsHintBefore}<code>backups</code>{S.backupsHintAfter}</span></span>
      </div>
      {system?.legacy_db_detected ? (
        <Notice tone="warn" style={{ margin: "14px 0 0" }}>
          {/* legacy name: the repo-dir database of old checkouts is data/finanse.db */}
          {S.legacyDb}<code>{system.legacy_db_path || "data/finanse.db"}</code>{S.legacyDbAfter}
          <Code cmd="cashu migrate-data" />
        </Notice>
      ) : null}
    </Card>
  );
}

// ---- Praca w tle (track W: worker status in /api/system, install / uninstall / run) ---------

const JOB_LABEL: Record<string, [string, string]> = JOB_LABELS;
const JOB_STATUS: Record<string, [string, "pos" | "neg" | "warn" | undefined]> = JOB_STATUSES;
const when = (iso: string | null | undefined) => { const t = serverDate(iso); return t ? timeFmt.format(t) : "-"; };

function WorkerSection() {
  const { system, profile, slug } = useShell();
  const toast = useToast();
  const [w, setW] = useState<WorkerInfo | null>(system?.worker ?? null);
  const [time, setTime] = useState(system?.worker?.schedule ?? "07:30");
  const [busy, setBusy] = useState<null | "install" | "uninstall" | "run">(null);
  const [err, setErr] = useState<string | null>(null);
  const [acking, setAcking] = useState(false);
  const sys = useContext(SystemChanged);
  // Fresh status on open (the shell loads /api/system once per page load) and after a write that changes it
  // (the time field keeps what the owner typed after the first read).
  const first = useRef(true);
  useEffect(() => {
    let alive = true;
    getSystem().then((s) => {
      if (!alive) return;
      setW(s.worker);
      if (first.current) setTime(s.worker?.schedule ?? "07:30");
      first.current = false;
    }).catch(() => {});
    return () => { alive = false; };
  }, [sys.tick]);
  const known = !!w && "schedule" in w; // older servers: only installed + last_run
  const supported = w?.supported !== false;
  const act = async (action: "install" | "uninstall" | "run", body: { time?: string } = {}) => {
    setBusy(action); setErr(null);
    try {
      const r = await postWorker(action, body);
      if (r.worker) setW(r.worker);
      sys.changed();
      if (action === "run") toast(S.runDone(JOB_STATUS[r.run?.status ?? ""]?.[0] ?? r.run?.status ?? "ok"), 3000);
      else toast(action === "install" ? S.installed : S.uninstalled);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setErr(status === 409 ? S.workerBusy : status === 501 ? S.noScheduler : errorText(e));
    } finally { setBusy(null); }
  };
  const on = (id: string) => profile.modules.some((m) => m.id === id && m.enabled);
  const schedule = w?.schedule ? S.dailyAt(w.schedule) : S.daily;
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
      sys.changed();
    } catch (e) { setErr(S.notSaved(errorText(e))); } finally { setAcking(false); }
  };
  return (
    <Card id="worker" title={SECTION.worker}>
      {reloc.worker && (
        <Notice tone="warn" style={{ margin: "0 0 10px" }}
          action={<button className="btn primary" disabled={!known || busy != null} onClick={() => act("install", { time: w?.schedule ?? time })}>{busy === "install" ? S.installing : S.reinstall}</button>}>
          <b>{reloc.worker}.</b>
        </Notice>
      )}
      {reloc.mcp && (
        <Notice tone="warn" style={{ margin: "0 0 10px" }}
          action={<button className="btn" disabled={acking} title={S.mcpReaddedTitle} onClick={ackMcp}>{acking ? S.saving : C.done}</button>}>
          {reloc.mcp}
        </Notice>
      )}
      <div className="row" style={{ paddingTop: 0 }}>
        <Switch on={!!w?.installed} disabled={!known || !supported || busy != null} label={S.everyDayAt(w?.schedule ?? time)}
          title={!known ? S.noInstallTitle : !supported ? S.noSchedulerTitle : undefined}
          onChange={(v) => act(v ? "install" : "uninstall", v ? { time } : {})} />
        <div className="grow">
          <div className="t">{S.everyDayAt(w?.schedule ?? time)} {w?.installed ? <Tag tone="pos">{S.running}</Tag> : <Tag>{S.notInstalled}</Tag>}</div>
          <div className="d">
            {w?.platform === "launchd" || !w?.platform ? "launchd" : w.platform} · {schedule}
            {w?.installed && w.next_run ? S.nextRun(when(w.next_run)) : ""}
            {w?.last_run ? `${S.lastRun(when(w.last_run))}${w.last_status ? ` (${JOB_STATUS[w.last_status]?.[0] ?? w.last_status})` : ""}` : S.neverRun}
          </div>
        </div>
        <button className="btn" disabled={!known || busy != null} onClick={() => act("run")}
          title={S.runNowTitle}>
          {busy === "run" ? S.starting : S.runNow}
        </button>
      </div>
      {known && (
        <div className="kv" style={{ margin: "10px 0" }}>
          <label className="k" htmlFor="set-worker-time">{S.hour}</label>
          <span className="v">
            <input id="set-worker-time" type="time" title={S.timeTitle} value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 110 }} />
            {w?.installed && time !== w.schedule && <button className="btn primary" disabled={busy != null} onClick={() => act("install", { time })}>{C.save}</button>}
          </span>
          {w?.log_path && <>
            <span className="k">{S.log}</span>
            <span className="v"><code style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{w.log_path}</code>
              <button className="btn" onClick={() => copyText(w.log_path!).then(() => toast(S.copied, 1500))}>{S.copy}</button></span>
          </>}
        </div>
      )}
      {err && <Notice tone="neg">{err}</Notice>}
      <div className="scroll">
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>{S.colJob}</th><th>{S.colModule}</th><th>{S.colSchedule}</th><th>{S.colLast}</th><th>{S.colStatus}</th></tr></thead>
          <tbody>
            {jobs.map((j) => {
              const [label, mod] = JOB_LABEL[j.job] ?? [j.job, j.module ?? "-"];
              const [st, tone] = JOB_STATUS[j.status] ?? [null, undefined];
              const sched = j.job === "digest" ? S.digestDay : j.job === "budget.sync" ? S.bankLimit(schedule) : schedule;
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
      <div className="foot">{S.workerFoot}</div>
    </Card>
  );
}

function presence(v: boolean | undefined, yes: string): ReactNode {
  if (v === undefined) return <Tag title={S.unknownStateTitle}>{S.unknownState}</Tag>;
  return v ? <Tag tone="pos">{yes}</Tag> : <Tag>{S.none}</Tag>;
}

function SecretsSection() {
  const { system } = useShell();
  const s = system?.secrets;
  return (
    <Card id="secrets" title={SECTION.secrets}>
      <div className="row">
        <div className="grow">
          <div className="t">{S.anthropicKey} {presence(s?.anthropic, S.inKeychain)}</div>
          <div className="d">{S.anthropicKeyHint}</div>
          <Code cmd="cashu secrets set anthropic" />
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">{S.ebKey} {presence(s?.enable_banking_key, S.inDataDir)}</div>
          <div className="d">{S.ebKeyHint}</div>
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">{S.apiToken}</div>
          <div className="d">{S.apiTokenHint}</div>
        </div>
      </div>
      <div className="foot">{S.secretsFoot}</div>
    </Card>
  );
}

const MIGRATION_STEP: Record<string, string> = MIGRATION_STEPS;

function AppSection({ theme, setTheme }: { theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const { system } = useShell();
  return (
    <Card id="app" title={SECTION.app}>
      <div className="kv">
        <span className="k">{S.theme}</span>
        <span className="v">
          <Seg<ThemePref> items={[[S.themeSystem, "system"], [S.themeLight, "light"], [S.themeDark, "dark"]]} value={theme} onChange={setTheme} />
          <span className="hint">{S.themeHint}</span>
        </span>
        <span className="k">{S.language}</span>
        <span className="v">
          <Seg<Lang | "system">
            label={S.language}
            items={[[S.languageSystem, "system"], ...LANGS.map((l): [string, Lang] => [LANG_NAME[l], l])]}
            value={storedLang() ?? "system"}
            onChange={(v) => setLanguage(v === "system" ? null : v)}
          />
          <span className="hint">{S.languageHint}</span>
        </span>
        <span className="k">{S.version}</span>
        <span className="v">{system?.version ?? "-"}</span>
      </div>
      {system?.rename_migration?.length ? (
        <Notice tone="warn" style={{ margin: "14px 0 0" }}>
          <b>{S.migrationFailed}</b>{S.migrationFailedHint}
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {system.rename_migration.map((p) => <li key={p.step}>{MIGRATION_STEP[p.step] ?? p.step}: <span className="hint">{p.detail}</span></li>)}
          </ul>
        </Notice>
      ) : null}
    </Card>
  );
}
