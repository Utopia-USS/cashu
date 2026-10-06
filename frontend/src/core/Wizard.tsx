// Profile wizard: Profil -> Moduły -> Prywatność (+ the agent workspace). Full screen on first
// launch (no profile yet), otherwise over the dimmed shell (see Shell). Creates the profile with
// POST /api/profiles, then (unless skipped) its agent workspace with POST /api/p/{slug}/workspace,
// and hands the profile back.
import { useEffect, useRef, useState } from "react";
import { nModules } from "../format";
import { ChoiceCard, Code, Notice, RadioList, Stepper, Switch, Tag } from "../ui";
import { createProfile, type ModuleInfo, type Privacy, type Profile, type SystemInfo } from "./api";
import { moduleDef, orderModules } from "./registry";
import { PROPOSAL_NOTE, ROUTINE_PERMISSIONS_HINT, ROUTINE_PERMISSIONS_LABEL, workspaceErrorText } from "./workspace";
import { getWorkspaceDefault, postWorkspace } from "./workspaceApi";
import { errorText } from "./messages";

export const CURRENCIES = ["PLN", "EUR", "USD", "CHF", "GBP"];
const LEGACY_SKIP_KEY = "finanse.legacySkipped";

export const legacySkipped = (): boolean => {
  try { return localStorage.getItem(LEGACY_SKIP_KEY) === "1"; } catch { return false; }
};

export const PRIVACY_OPTIONS: { value: Privacy; title: string; desc: string; example: string; tag?: boolean }[] = [
  {
    value: "strict", title: "Ścisły", tag: true,
    desc: "Udziały procentowe, kategorie, daty, nazwy instrumentów. Bez kwot, numerów kont i nazwisk.",
    example: "Przykład: zamiast „CD Projekt: 12 400 zł\" agent dostaje „CD Projekt: 6,7 % portfela\".",
  },
  {
    value: "amounts", title: "Z kwotami",
    desc: "Także kwoty w walucie konta. Bez numerów kont, IBAN-ów i danych osobowych.",
    example: "Przykład: pytanie „ile wydałam na jedzenie we wrześniu\".",
  },
];

/** Module ids `id` needs (transitively), per depends_on. */
function withDeps(id: string, all: ModuleInfo[], acc = new Set<string>()): Set<string> {
  if (acc.has(id)) return acc;
  acc.add(id);
  for (const d of all.find((m) => m.id === id)?.depends_on ?? []) withDeps(d, all, acc);
  return acc;
}

export function Wizard({ firstLaunch, system, modules, existing, onCreated, onCancel }: {
  firstLaunch: boolean;
  system: SystemInfo | null;
  modules: ModuleInfo[];
  existing: Profile[];
  onCreated: (p: Profile) => void;
  onCancel?: () => void;
}) {
  const ordered = orderModules(modules);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("PLN");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(ordered.some((m) => m.id === "budget" && m.available) ? ["budget"] : []),
  );
  const [privacy, setPrivacy] = useState<Privacy>("strict");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipLegacy, setSkipLegacy] = useState(legacySkipped);
  // Agent workspace (core/workspace): on by default, path prefilled with the server's default.
  const [wsOn, setWsOn] = useState(true);
  const [wsPath, setWsPath] = useState("");
  const [wsTouched, setWsTouched] = useState(false);
  const [wsRoutine, setWsRoutine] = useState(false);
  const [wsErr, setWsErr] = useState<string | null>(null);
  // Set once the profile exists: a failed workspace step can be retried or skipped, never re-creates it.
  const [created, setCreated] = useState<Profile | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const cancel = () => (created ? onCreated(created) : onCancel?.());
  useEffect(() => { if (step === 0) nameRef.current?.focus(); }, [step]);
  useEffect(() => {
    if (firstLaunch || !onCancel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) cancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const trimmed = name.trim();
  const investmentsPicked = picked.has("investments");
  useEffect(() => {
    if (step !== 2 || wsTouched || created || !trimmed) return;
    let alive = true;
    getWorkspaceDefault(trimmed).then((d) => { if (alive && d.path) setWsPath(d.path); }).catch(() => { /* field stays empty: the server default */ });
    return () => { alive = false; };
  }, [step, trimmed, wsTouched, created]);
  const validateName = (): boolean => {
    if (!trimmed) { setNameErr("Podaj nazwę profilu."); return false; }
    if (existing.some((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      setNameErr("Profil o tej nazwie już istnieje."); return false;
    }
    setNameErr(null);
    return true;
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) for (const d of withDeps(id, modules)) next.add(d);
    else {
      // Unticking a module also unticks everything that depends on it.
      const drop = (x: string) => {
        next.delete(x);
        for (const m of modules) if (next.has(m.id) && m.depends_on.includes(x)) drop(m.id);
      };
      drop(id);
    }
    setPicked(next);
  };

  const create = async () => {
    setBusy(true); setErr(null); setWsErr(null);
    let p = created;
    if (!p) {
      try {
        p = await createProfile({
          name: trimmed, base_currency: currency, mcp_privacy: privacy,
          modules: ordered.filter((m) => picked.has(m.id)).map((m) => m.id),
        });
        setCreated(p);
      } catch (e) {
        setErr(errorText(e));
        setBusy(false);
        return;
      }
    }
    if (wsOn) {
      try {
        await postWorkspace(p.slug, { path: wsPath.trim() || null, routine_permissions: investmentsPicked && wsRoutine });
      } catch (e) {
        setWsErr(workspaceErrorText(e));
        setBusy(false);
        return;
      }
    }
    onCreated(p);
  };

  const pickedNames = ordered.filter((m) => picked.has(m.id)).map((m) => moduleDef(m.id, modules).name);
  const title = step === 0 ? (firstLaunch ? "Witaj w cashU" : "Nowy profil") : `Nowy profil: ${trimmed}`;
  const lead = [
    firstLaunch ? "Wszystko działa lokalnie na tym komputerze." : null,
    "Do zmiany później w Ustawieniach.",
    "Dotyczy tylko narzędzi MCP (Claude Code, Claude Desktop). Analizy w aplikacji nie wychodzą z komputera.",
  ][step];
  const showLegacy = firstLaunch && step === 0 && system?.legacy_db_detected && !skipLegacy;

  return (
    <div className="wizard" role={firstLaunch ? undefined : "dialog"} aria-modal={firstLaunch ? undefined : true} aria-label="Nowy profil">
      {!firstLaunch && onCancel && <button className="icon-btn close" title="Zamknij (Esc)" aria-label="Zamknij" onClick={cancel}>✕</button>}
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      <Stepper steps={["Profil", "Moduły", "Prywatność"]} current={step} />

      <div className="card">
        {step === 0 && (
          <form onSubmit={(e) => { e.preventDefault(); if (validateName()) setStep(1); }} id="wz-step">
            {showLegacy && (
              <Notice tone="info" action={
                <button type="button" className="btn" onClick={() => {
                  setSkipLegacy(true);
                  try { localStorage.setItem(LEGACY_SKIP_KEY, "1"); } catch { /* ignore */ }
                }}>Pomiń</button>
              }>
                Dane z poprzedniej wersji: <code>{system?.legacy_db_path || "data/finanse.db"}</code>. Zamknij aplikację i uruchom:
                <Code cmd="finanse migrate-data" />
              </Notice>
            )}
            <div className="form-row">
              <div className="field">
                <label htmlFor="wz-name">Nazwa profilu</label>
                <input id="wz-name" ref={nameRef} value={name} maxLength={40} autoComplete="off"
                  aria-invalid={!!nameErr} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(null); }} />
                {nameErr && <span className="fe">{nameErr}</span>}
              </div>
              <div className="field">
                <label htmlFor="wz-cur" title="Waluta nagłówka wartości netto; inne waluty osobno, bez przeliczania.">Waluta bazowa</label>
                <select id="wz-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </form>
        )}

        {step === 1 && (
          <div className="choices">
            {ordered.map((m) => {
              const def = moduleDef(m.id, modules);
              const deps = m.depends_on.map((d) => moduleDef(d, modules).name);
              return (
                <ChoiceCard key={m.id} checked={picked.has(m.id)} disabled={!m.available}
                  title={def.name} tag={!m.available ? <Tag>wkrótce</Tag> : undefined}
                  desc={def.desc || m.description}
                  hint={[deps.length ? `Wymaga: ${deps.join(", ")}.` : "", def.hint ?? ""].filter(Boolean).join(" ") || undefined}
                  onChange={(on) => toggle(m.id, on)} />
              );
            })}
          </div>
        )}

        {step === 2 && (
          <>
            <RadioList<Privacy> name="wz-privacy" value={privacy} onChange={setPrivacy}
              options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, title: o.title, desc: o.desc, tooltip: o.example, tag: o.tag ? <Tag>domyślny</Tag> : undefined }))} />
            <div className="muted" style={{ fontSize: 12.5, margin: "4px 0 16px" }}>{PROPOSAL_NOTE}</div>
            <section style={{ margin: "0 0 16px" }} aria-labelledby="wz-ws-h">
              <div className="controls" style={{ margin: "0 0 6px" }}>
                <Switch on={wsOn} label="Utwórz workspace agenta" onChange={setWsOn} disabled={busy} />
                <strong id="wz-ws-h" style={{ fontSize: 14 }} title="CLAUDE.md z kontekstem profilu, tylko serwer MCP tego profilu, skille włączonych modułów, blokada odczytu katalogu danych. Twoje pliki zostają przy aktualizacjach.">Workspace agenta (Claude Code)</strong>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Folder dla Claude Code: CLAUDE.md, serwer MCP profilu, skille modułów. Dane tylko przez MCP.</div>
              {wsOn ? (
                <>
                  <div className="field">
                    <label htmlFor="wz-ws">Folder workspace</label>
                    <input id="wz-ws" value={wsPath} placeholder="~/Documents/finanse/<profil>" autoComplete="off" spellCheck={false}
                      disabled={busy} onChange={(e) => { setWsPath(e.target.value); setWsTouched(true); }} />
                  </div>
                  {investmentsPicked && (
                    <>
                      <div className="controls" style={{ margin: "0 0 4px", fontSize: 13 }}>
                        <Switch on={wsRoutine} label={ROUTINE_PERMISSIONS_LABEL} onChange={setWsRoutine} disabled={busy} />
                        <span>{ROUTINE_PERMISSIONS_LABEL}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12.5 }}>{ROUTINE_PERMISSIONS_HINT}</div>
                    </>
                  )}
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12.5 }}>Do utworzenia później: Ustawienia › Agent AI.</div>
              )}
            </section>
            <section className="summary">
              <h2 style={{ marginBottom: 8 }}>Podsumowanie</h2>
              <div className="kv">
                <span className="k">Profil</span><span className="v">{trimmed} · {currency}</span>
                <span className="k">Moduły</span><span className="v">{pickedNames.length ? pickedNames.join(", ") : "wartość netto i gotówka"}</span>
                <span className="k">Agent AI</span>
                <span className="v">
                  {privacy === "strict" ? <>poziom ścisły · <span className="muted">udziały procentowe, nie kwoty</span></> : <>poziom z kwotami · <span className="muted">kwoty bez numerów kont</span></>}
                </span>
                <span className="k">Dane</span><span className="v" style={{ fontSize: 13 }}><code>{system?.data_dir ?? "-"}</code></span>
                <span className="k">Workspace agenta</span>
                <span className="v" style={{ fontSize: 13 }}>{wsOn ? <code>{wsPath.trim() || "folder domyślny"}</code> : "pominięty"}</span>
              </div>
            </section>
            {err && <Notice tone="neg" style={{ margin: "14px 0 0" }}>Nie udało się utworzyć profilu: {err}</Notice>}
            {created && wsErr && (
              <Notice tone="warn" style={{ margin: "14px 0 0" }} action={
                <button type="button" className="btn" onClick={() => onCreated(created)} disabled={busy}>Pomiń</button>
              }>
                Profil utworzony, workspace nie: {wsErr}
              </Notice>
            )}
          </>
        )}

        <div className="controls" style={{ margin: "18px 0 0" }}>
          {step > 0 && !created && <button className="btn" onClick={() => setStep(step - 1)} disabled={busy}>← Wstecz</button>}
          <span className="muted" style={{ fontSize: 12 }}>
            Krok {step + 1} z 3{step === 1 && ` · wybrano ${nModules(picked.size)}`}
          </span>
          <span className="spacer" />
          {step === 1 && !picked.size && <span className="muted" style={{ fontSize: 12 }}>Bez modułów: tylko wartość netto i gotówka.</span>}
          {step === 0 && <button className="btn primary" type="submit" form="wz-step">Dalej →</button>}
          {step === 1 && <button className="btn primary" onClick={() => setStep(2)}>Dalej →</button>}
          {step === 2 && (
            <button className="btn primary" onClick={create} disabled={busy}>
              {created ? (busy ? "Tworzę workspace…" : "Spróbuj ponownie") : busy ? "Tworzę profil…" : "Utwórz profil"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
