// Module blank page (SetupPage pattern): its setup steps with
// live status from GET /api/p/{slug}/modules/{id}/setup (polled every 5 s and on
// focus), and how to run the module's setup skill in Claude Code.
import { type ReactNode, useEffect } from "react";
import { usePoll } from "../hooks";
import { ck } from "../swr";
import { Code, copyText, Notice, SetupSteps, Skeleton, Tag, useToast } from "../ui";
import { getSetup, type ModuleInfo, type SetupAction, type SetupInfo, type SetupState } from "./api";
import { moduleDef, tabKey } from "./registry";
import type { View } from "./types";
import { pathToView, useShell } from "./context";
import { TRANSLOCATED_TEXT } from "./workspace";

const POLL_MS = 5000;

export const stepsTag = (info: SetupInfo | null, state?: SetupState): ReactNode => {
  if (state === "ready" || info?.state === "ready") return <Tag tone="pos">gotowy</Tag>;
  const n = info?.steps.length ?? 0;
  if (!info || !n) return <Tag tone="warn">nieskonfigurowany</Tag>;
  const done = info.steps.filter((s) => s.status === "done").length;
  return <Tag tone="warn">{done} z {n} {n === 1 ? "kroku" : "kroków"}</Tag>;
};

export const PRIVACY_PLAIN: Record<string, ReactNode> = {
  strict: <><b>Poziom ścisły:</b> udziały, kategorie, daty; bez kwot i numerów kont.</>,
  amounts: <><b>Poziom z kwotami:</b> także kwoty; bez numerów kont, IBAN-ów i danych osobowych.</>,
};

/** Target of a "view"/"tab" action -> View. Accepts a view path (see pathToView; "module/tab" and
 * "module:tab" are read as "module.tab"), a tab id of this module, or a module id (its first tab; a module
 * without tabs lives on Przegląd: Przegląd with its widget focused, F7 merge). */
export function actionView(moduleId: string, target: string, modules: ModuleInfo[]): View | null {
  const t = target.trim().replace(/^([a-z_]+)[/:]([a-z_]+)$/, (m, a: string, b: string) => (a === "settings" || a === "setup" ? m : `${a}.${b}`));
  if (!t) return null;
  if (t.includes(".") || t.includes("/") || t === "overview" || t === "settings") return pathToView(t);
  const own = moduleDef(moduleId, modules);
  if (own.tabs.some((x) => x.id === t)) return { kind: "tab", tab: tabKey(moduleId, t) };
  const other = moduleDef(t, modules);
  return other.tabs[0] ? { kind: "tab", tab: tabKey(t, other.tabs[0].id) } : { kind: "tab", tab: "overview", sub: t };
}

/** A setup step action. Known kinds: view|tab (see actionView), settings (section id),
 * cli|copy|command (copy `target`), url (open link). Anything else renders disabled. */
function ActionButton({ moduleId, a }: { moduleId: string; a: SetupAction }) {
  const { go, modules } = useShell();
  const toast = useToast();
  const kind = a.kind.toLowerCase();
  let run: (() => void) | null = null;
  if (kind === "tab" || kind === "navigate" || kind === "view") {
    const v = actionView(moduleId, a.target, modules);
    if (v) run = () => go(v);
  } else if (kind === "settings") {
    run = () => go({ kind: "settings", section: a.target || undefined });
  } else if (kind === "copy" || kind === "cli" || kind === "command") {
    run = () => copyText(a.target).then(() => toast("Skopiowano", 1500));
  } else if ((kind === "url" || kind === "link") && /^(https?:\/\/|\/)/.test(a.target)) {
    run = () => window.open(a.target, "_blank", "noopener");
  }
  const disabled = a.disabled || !run;
  return (
    <button className="btn" disabled={disabled} onClick={run ?? undefined}
      title={a.hint ?? (disabled && !a.disabled ? "Dostępne wkrótce" : kind === "copy" || kind === "cli" || kind === "command" ? a.target : undefined)}>
      {a.label}
    </button>
  );
}

export function SetupPage({ moduleId, state }: { moduleId: string; state: SetupState }) {
  const { slug, profile, modules, go, reloadProfiles } = useShell();
  const def = moduleDef(moduleId, modules);
  const { data, error } = usePoll(() => getSetup(slug, moduleId), POLL_MS, [slug, moduleId], { key: ck(slug, "setup", moduleId) });

  // A step finished in Claude Code or the CLI can flip the module state: refresh the
  // profile list so the tab dot and the overview card follow without a reload.
  useEffect(() => {
    if (data && data.state !== state) void reloadProfiles();
  }, [data?.state, state, reloadProfiles]);

  const skill = data?.skill;
  const firstTab = def.tabs[0];

  return (
    <>
      <section className="card chart-card">
        <div className="controls" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{def.name} · konfiguracja</h2>
          {stepsTag(data, data?.state)}
        </div>
        {error && <Notice tone="neg">Nie udało się pobrać stanu: {error}</Notice>}
        {data?.state === "ready" && (
          <Notice tone="pos" style={{ margin: "10px 0 0" }}
            action={firstTab
              ? <button className="btn" onClick={() => go({ kind: "tab", tab: tabKey(moduleId, firstTab.id) })}>{firstTab.label} →</button>
              : <button className="btn" onClick={() => go({ kind: "tab", tab: "overview", sub: moduleId })}>Przegląd →</button>}>
            Skonfigurowany.
          </Notice>
        )}
        {!data && !error ? (
          <div style={{ display: "grid", gap: 14, padding: "12px 0" }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}
          </div>
        ) : data && (
          data.steps.length ? (
            <SetupSteps steps={data.steps.map((s) => ({
              key: s.id,
              title: s.title,
              hint: s.description,
              status: s.status,
              actions: s.actions.length ? s.actions.map((a, i) => <ActionButton key={i} moduleId={moduleId} a={a} />) : undefined,
            }))} />
          ) : <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Brak kroków konfiguracji.</div>
        )}
      </section>

      {skill && (
        <section className="card chart-card">
          <h2>Z pomocą Claude Code</h2>
          {skill.translocated && <Notice tone="warn">{TRANSLOCATED_TEXT}</Notice>}
          <SetupSteps steps={[
            {
              key: "mcp", status: "on", title: "Podłącz MCP do Claude Code", tag: <Tag>raz na profil</Tag>,
              body: <Code cmd={skill.mcp_add} />,
              hint: "Claude Desktop: Ustawienia › Agent AI.",
            },
            {
              key: "skill", status: "todo", title: "Uruchom skill w Claude Code",
              body: <Code cmd={skill.command} />,
              hint: def.skillHint,
            },
          ]} />
          <Notice tone="info" style={{ margin: "12px 0 0" }}
            action={<button className="btn" onClick={() => go({ kind: "settings", section: "agent" })}>Ustawienia</button>}>
            {PRIVACY_PLAIN[profile.mcp_privacy] ?? PRIVACY_PLAIN.strict}
          </Notice>
        </section>
      )}
    </>
  );
}
