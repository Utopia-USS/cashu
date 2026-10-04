// Ustawienia: sticky section nav (scroll-spy) + stacked cards. Profile fields save
// with Zapisz; switches and radios save on change with a toast.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAsync } from "../hooks";
import { Code, copyText, Notice, RadioList, Seg, Switch, Tag, useToast } from "../ui";
import {
  getSetup, mcpAddCommand, type ModuleInfo, patchProfile, type Privacy, putProfileModules, type ProfileModule,
} from "./api";
import { moduleDef, orderModules } from "./registry";
import { PRIVACY_PLAIN, stepsTag } from "./SetupPage";
import { useShell } from "./context";
import type { ThemePref } from "./theme";
import { CURRENCIES, legacySkipped, PRIVACY_OPTIONS } from "./Wizard";

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
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
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
          <span className="hint">widoki przeliczone po kursie NBP, z datą kursu</span>
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
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const enabled = new Set(profile.modules.filter((m) => m.enabled).map((m) => m.id));

  const toggle = async (id: string, on: boolean) => {
    setBusy(id); setErr(null);
    try {
      await putProfileModules(slug, nextEnabled(id, on, enabled, modules));
      await reloadProfiles();
      toast("Zapisano");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <Card id="modules" title="Moduły">
      {orderModules(modules).map((m) => (
        <ModuleRow key={m.id} info={m} pm={profile.modules.find((x) => x.id === m.id)}
          busy={busy === m.id} onToggle={(on) => toggle(m.id, on)} />
      ))}
      {err && <Notice tone="neg" style={{ margin: "10px 0 0" }}>Nie udało się zapisać modułów: {err}</Notice>}
      <div className="foot">Wyłączenie modułu ukrywa jego zakładki i narzędzia MCP; dane zostają w bazie i wracają po włączeniu.</div>
    </Card>
  );
}

function ModuleRow({ info, pm, busy, onToggle }: { info: ModuleInfo; pm?: ProfileModule; busy: boolean; onToggle: (on: boolean) => void }) {
  const { slug, modules, go } = useShell();
  const def = moduleDef(info.id, modules);
  const on = !!pm?.enabled;
  const pending = on && pm?.setup_state !== "ready";
  const { data } = useAsync(
    () => (pending ? getSetup(slug, info.id) : Promise.resolve(null)),
    [slug, info.id, pending, pm?.setup_state],
  );
  return (
    <div className="row">
      <Switch on={on} disabled={busy || !info.available} label={`Moduł ${def.name}`} onChange={onToggle}
        title={!info.available ? "Moduł jeszcze niedostępny" : undefined} />
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
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card id="agent" title="Agent AI (MCP)">
      <RadioList<Privacy> name="set-privacy" value={profile.mcp_privacy} onChange={change} disabled={busy}
        options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, title: o.title, desc: o.short, tag: o.tag ? <Tag>domyślny</Tag> : undefined }))} />
      {err && <Notice tone="neg">Nie udało się zapisać poziomu: {err}</Notice>}
      <Notice tone="info">
        {profile.mcp_privacy === "strict"
          ? <>Przykład na poziomie ścisłym: zamiast „CD Projekt: 12 400 zł" agent dostaje „CD Projekt: 6,7 % portfela".</>
          : PRIVACY_PLAIN.amounts}
        {" "}Zapis przez agenta (reguła, decyzja, zmiana strategii) to zawsze propozycja, którą zatwierdzasz w aplikacji.
      </Notice>
      <div className="kv" style={{ marginTop: 14 }}>
        <span className="k">Claude Code</span>
        <span className="v block"><Code cmd={mcpAddCommand(slug)} /></span>
        <span className="k">Claude Desktop</span>
        <span className="v block"><Code cmd={desktopJson(slug)} multiline /></span>
      </div>
      <div className="controls" style={{ margin: "14px 0 6px" }}>
        <strong style={{ fontSize: 14 }}>Dziennik wywołań</strong>
        <Tag>ostatnie 7 dni · 0</Tag>
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Czas</th><th>Narzędzie</th><th>Poziom</th><th>Wynik</th></tr></thead>
          <tbody>
            <tr><td colSpan={4} className="muted">Brak wywołań. Dziennik zacznie się zapełniać po podłączeniu serwera MCP.</td></tr>
          </tbody>
        </table>
      </div>
    </Card>
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
          Stara baza <code>{system.legacy_db_path || "data/finanse.db"}</code> nadal leży w katalogu repozytorium.
          {legacySkipped() ? " Pominięto ją przy tworzeniu profilu." : ""} Żeby przenieść ją do katalogu danych z kopią zapasową, zamknij aplikację i uruchom:
          <Code cmd="finanse migrate-data" />
        </Notice>
      ) : (
        <div className="foot">Brak starej bazy w katalogu repozytorium.</div>
      )}
    </Card>
  );
}

function WorkerSection() {
  const { system, profile } = useShell();
  const w = system?.worker;
  const on = (id: string) => profile.modules.some((m) => m.id === id && m.enabled);
  const jobs: [string, string, string][] = [
    ...(on("investments") ? [["Sprawdzenie reguł", "Inwestycje", "codziennie 07:00"] as [string, string, string]] : []),
    ...(on("budget") ? [["Synchronizacja banków", "Budżet", "co 6 h (limit banku)"] as [string, string, string]] : []),
    ["Podsumowanie tygodnia", "wszystkie", "niedziela 08:00"],
  ];
  return (
    <Card id="worker" title="Praca w tle">
      <div className="row" style={{ paddingTop: 0 }}>
        <Switch on={!!w?.installed} disabled onChange={() => {}} label="Uruchamiaj w tle po zalogowaniu" title="Instalacja z aplikacji pojawi się w kolejnej wersji" />
        <div className="grow">
          <div className="t">Uruchamiaj w tle po zalogowaniu {w?.installed ? <Tag tone="pos">działa</Tag> : <Tag>nie zainstalowano</Tag>}</div>
          <div className="d">
            launchd · ten sam program co aplikacja
            {w?.installed ? ` · ostatni przebieg ${w.last_run ?? "-"}` : " · instalacja z aplikacji pojawi się w kolejnej wersji"}
          </div>
        </div>
        <button className="btn" disabled title="Dostępne wkrótce">Zainstaluj (launchd)</button>
      </div>
      <div className="scroll">
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Zadanie</th><th>Moduł</th><th>Harmonogram</th><th>Ostatnio</th><th>Status</th></tr></thead>
          <tbody>
            {jobs.map(([job, mod, when]) => (
              <tr key={job} className="muted">
                <td>{job}</td><td>{mod}</td><td>{when}</td><td>-</td><td>-</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="foot">Powiadomienie natychmiast tylko dla sygnałów „do działania"; reszta czeka na podsumowanie tygodnia.</div>
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
          <div className="d">pęk kluczy systemu · używany do kategoryzacji (Budżet), gdy wybrano backend anthropic</div>
          <Code cmd="finanse secrets set anthropic" />
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">Enable Banking · klucz prywatny {presence(s?.enablebanking_key, "w katalogu danych")}</div>
          <div className="d">plik .pem w katalogu danych · sesje per bank w bazie</div>
        </div>
      </div>
      <div className="row">
        <div className="grow">
          <div className="t">Token API aplikacji</div>
          <div className="d">losowy przy każdym uruchomieniu · tylko 127.0.0.1 · nie wymaga obsługi</div>
        </div>
      </div>
      <div className="foot">Wartości sekretów nigdy nie są tu pokazywane. Sekrety nie trafiają do logów, eksportów ani do agenta AI.</div>
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
