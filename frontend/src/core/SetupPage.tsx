// Module blank page (SetupPage pattern): what the module does, its setup steps with
// live status from GET /api/p/{slug}/modules/{id}/setup (polled every 5 s and on
// focus), and how to run the module's setup skill in Claude Code.
import { type ReactNode, useEffect } from "react";
import { usePoll } from "../hooks";
import { Code, copyText, Notice, SetupSteps, Skeleton, Tag, useToast } from "../ui";
import { getSetup, type ModuleInfo, type SetupAction, type SetupInfo, type SetupState } from "./api";
import { moduleDef, tabKey } from "./registry";
import type { View } from "./types";
import { pathToView, useShell } from "./context";

const POLL_MS = 5000;

export const stepsTag = (info: SetupInfo | null, state?: SetupState): ReactNode => {
  if (state === "ready" || info?.state === "ready") return <Tag tone="pos">gotowy</Tag>;
  const n = info?.steps.length ?? 0;
  if (!info || !n) return <Tag tone="warn">nieskonfigurowany</Tag>;
  const done = info.steps.filter((s) => s.status === "done").length;
  return <Tag tone="warn">{done} z {n} {n === 1 ? "kroku" : "kroków"}</Tag>;
};

export const PRIVACY_PLAIN: Record<string, ReactNode> = {
  strict: <><b>Poziom prywatności: ścisły.</b> Agent widzi udziały procentowe, kategorie i daty, nie widzi kwot ani numerów kont.</>,
  amounts: <><b>Poziom prywatności: z kwotami.</b> Agent widzi też kwoty w walucie konta, nie widzi numerów kont, IBAN-ów ani danych osobowych.</>,
};

/** Target of a "view"/"tab" action -> View. Accepts a view path (see pathToView; "module/tab" and
 * "module:tab" are read as "module.tab"), a tab id of this module, or a module id (its first tab). */
export function actionView(moduleId: string, target: string, modules: ModuleInfo[]): View | null {
  const t = target.trim().replace(/^([a-z_]+)[/:]([a-z_]+)$/, (m, a: string, b: string) => (a === "settings" || a === "setup" ? m : `${a}.${b}`));
  if (!t) return null;
  if (t.includes(".") || t.includes("/") || t === "overview" || t === "settings") return pathToView(t);
  const own = moduleDef(moduleId, modules);
  if (own.tabs.some((x) => x.id === t)) return { kind: "tab", tab: tabKey(moduleId, t) };
  const other = moduleDef(t, modules);
  return other.tabs[0] ? { kind: "tab", tab: tabKey(t, other.tabs[0].id) } : null;
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
  const { data, error } = usePoll(() => getSetup(slug, moduleId), POLL_MS, [slug, moduleId]);

  // A step finished in Claude Code or the CLI can flip the module state: refresh the
  // profile list so the tab dot and the overview card follow without a reload.
  useEffect(() => {
    if (data && data.state !== state) void reloadProfiles();
  }, [data?.state, state, reloadProfiles]);

  const skill = data?.skill;
  const blurb = def.skillBlurb ?? "Skill {skill} przeprowadzi konfigurację modułu i zapisze wynik przez aplikację. Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.";
  const skillName = skill?.command.replace(/^\//, "") ?? "";
  const [pre, post] = blurb.split("{skill}");
  const firstTab = def.tabs[0];

  return (
    <>
      <section className="card chart-card">
        <div className="controls" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{def.name} · konfiguracja</h2>
          {stepsTag(data, data?.state)}
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>status odświeża się na żywo</span>
        </div>
        <p style={{ margin: "0 0 6px", maxWidth: "78ch" }}>{def.intro}</p>
        {error && <Notice tone="neg">Nie udało się pobrać stanu konfiguracji: {error}. Próbuję ponownie co 5 s.</Notice>}
        {data?.state === "ready" && (
          <Notice tone="pos" style={{ margin: "10px 0 0" }}
            action={firstTab && <button className="btn" onClick={() => go({ kind: "tab", tab: tabKey(moduleId, firstTab.id) })}>{firstTab.label} →</button>}>
            Moduł jest skonfigurowany.
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
          ) : <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Moduł nie podał jeszcze kroków konfiguracji.</div>
        )}
      </section>

      {skill && (
        <section className="card chart-card">
          <h2>Z pomocą Claude Code</h2>
          <p style={{ margin: "0 0 10px", maxWidth: "78ch" }}>
            {pre}{post !== undefined && <><code>{skillName}</code>{post}</>}
          </p>
          <SetupSteps steps={[
            {
              key: "mcp", status: "on", title: "Podłącz MCP do Claude Code", tag: <Tag>raz na profil</Tag>,
              body: <Code cmd={skill.mcp_add} />,
              hint: "Claude Desktop: konfiguracja JSON jest w Ustawieniach → Agent AI.",
            },
            {
              key: "skill", status: "todo", title: "Uruchom skill w Claude Code",
              body: <Code cmd={skill.command} />,
              hint: def.skillHint,
            },
          ]} />
          <Notice tone="info" style={{ margin: "12px 0 0" }}
            action={<button className="btn" onClick={() => go({ kind: "settings", section: "agent" })}>Ustawienia</button>}>
            {PRIVACY_PLAIN[profile.mcp_privacy] ?? PRIVACY_PLAIN.strict} Zmień w Ustawieniach → Agent AI.
          </Notice>
        </section>
      )}
    </>
  );
}
