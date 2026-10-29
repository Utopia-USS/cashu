// Profile wizard: Profil -> Moduły -> Prywatność (+ the agent workspace). Full screen on first
// launch (no profile yet), otherwise over the dimmed shell (see Shell). Creates the profile with
// POST /api/profiles, then (unless skipped) its agent workspace with POST /api/p/{slug}/workspace,
// and hands the profile back.
import { useEffect, useRef, useState } from "react";
import { nModules } from "../format";
import { ChoiceCard, Code, Notice, RadioList, Stepper, Switch, Tag } from "../ui";
import { createProfile, type ModuleInfo, type Privacy, type Profile, type SystemInfo } from "./api";
import { moduleDef, orderModules } from "./registry";
import { workspaceErrorText } from "./workspace";
import { WS } from "./workspace.strings.ts";
import { getWorkspaceDefault, postWorkspace } from "./workspaceApi";
import { errorText } from "./messages";
import { readStored } from "./storage";
import { C } from "../common.strings.ts";
import { PRIVACY, S } from "./Wizard.strings.ts";

export const CURRENCIES = ["PLN", "EUR", "USD", "CHF", "GBP"];
const LEGACY_SKIP_KEY = "cashu.legacySkipped";

export const legacySkipped = (): boolean => {
  try { return readStored(localStorage, LEGACY_SKIP_KEY) === "1"; } catch { return false; }
};


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
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
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
    if (!trimmed) { setNameErr(S.nameRequired); return false; }
    if (existing.some((p) => p.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      setNameErr(S.nameTaken); return false;
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
    if (!privacy) return;
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
  const title = step === 0 ? (firstLaunch ? S.welcome : S.newProfile) : S.newProfileNamed(trimmed);
  const lead = [
    firstLaunch ? S.leadLocal : null,
    S.leadLater,
    S.leadMcp,
  ][step];
  const showLegacy = firstLaunch && step === 0 && system?.legacy_db_detected && !skipLegacy;

  return (
    <div className="wizard" role={firstLaunch ? undefined : "dialog"} aria-modal={firstLaunch ? undefined : true} aria-label={S.newProfile}>
      {!firstLaunch && onCancel && <button className="icon-btn close" title={S.closeEsc} aria-label={C.close} onClick={cancel}>✕</button>}
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      <Stepper steps={[S.stepProfile, S.stepModules, S.stepPrivacy]} current={step} />

      <div className="card">
        {step === 0 && (
          <form onSubmit={(e) => { e.preventDefault(); if (validateName()) setStep(1); }} id="wz-step">
            {showLegacy && (
              <Notice tone="info" action={
                <button type="button" className="btn" onClick={() => {
                  setSkipLegacy(true);
                  try { localStorage.setItem(LEGACY_SKIP_KEY, "1"); } catch { /* ignore */ }
                }}>{S.skip}</button>
              }>
                {/* legacy name: the repo-dir database of old checkouts is data/finanse.db */}
                {S.legacyData}<code>{system?.legacy_db_path || "data/finanse.db"}</code>{S.legacyDataAfter}
                <Code cmd="cashu migrate-data" />
              </Notice>
            )}
            <div className="form-row">
              <div className="field">
                <label htmlFor="wz-name">{S.profileName}</label>
                <input id="wz-name" ref={nameRef} value={name} maxLength={40} autoComplete="off"
                  aria-invalid={!!nameErr} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(null); }} />
                {nameErr && <span className="fe">{nameErr}</span>}
              </div>
              <div className="field">
                <label htmlFor="wz-cur" title={S.baseCurrencyTitle}>{S.baseCurrency}</label>
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
                  title={def.name} tag={!m.available ? <Tag>{S.soon}</Tag> : undefined}
                  desc={def.desc || m.description}
                  hint={[deps.length ? S.requires(deps.join(", ")) : "", def.hint ?? ""].filter(Boolean).join(" ") || undefined}
                  onChange={(on) => toggle(m.id, on)} />
              );
            })}
          </div>
        )}

        {step === 2 && (
          <>
            <h2 id="wz-privacy-h" style={{ margin: "0 0 8px" }}>{PRIVACY.question}</h2>
            <RadioList<Privacy> name="wz-privacy" label={PRIVACY.question} value={privacy} onChange={setPrivacy} disabled={!!created}
              options={PRIVACY.options.map((o) => ({ value: o.value, title: o.title, desc: o.desc, tooltip: o.example }))} />
            <div className="muted" style={{ fontSize: 12.5, margin: "4px 0 16px" }}>{PRIVACY.common} {WS.proposalNote}</div>
            <section style={{ margin: "0 0 16px" }} aria-labelledby="wz-ws-h">
              <div className="controls" style={{ margin: "0 0 6px" }}>
                <Switch on={wsOn} label={S.createWorkspace} onChange={setWsOn} disabled={busy} />
                <strong id="wz-ws-h" style={{ fontSize: 14 }} title={S.workspaceTitle}>{S.workspaceHeading}</strong>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{S.workspaceDesc}</div>
              {wsOn ? (
                <>
                  <div className="field">
                    <label htmlFor="wz-ws">{S.workspaceFolder}</label>
                    <input id="wz-ws" value={wsPath} placeholder={S.workspacePlaceholder} autoComplete="off" spellCheck={false}
                      disabled={busy} onChange={(e) => { setWsPath(e.target.value); setWsTouched(true); }} />
                  </div>
                  {investmentsPicked && (
                    <>
                      <div className="controls" style={{ margin: "0 0 4px", fontSize: 13 }}>
                        <Switch on={wsRoutine} label={WS.routinePermissionsLabel} onChange={setWsRoutine} disabled={busy} />
                        <span>{WS.routinePermissionsLabel}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12.5 }}>{WS.routinePermissionsHint}</div>
                    </>
                  )}
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12.5 }}>{S.workspaceLater}</div>
              )}
            </section>
            <section className="summary">
              <h2 style={{ marginBottom: 8 }}>{S.summary}</h2>
              <div className="kv">
                <span className="k">{S.profile}</span><span className="v">{trimmed} · {currency}</span>
                <span className="k">{S.modules}</span><span className="v">{pickedNames.length ? pickedNames.join(", ") : S.noModules}</span>
                <span className="k">{S.agent}</span>
                <span className="v">
                  {privacy === "strict" ? <>{S.strictLevel}<span className="muted">{S.strictLevelHint}</span></>
                    : privacy === "amounts" ? <>{S.amountsLevel}<span className="muted">{S.amountsLevelHint}</span></>
                    : <span className="muted">{S.toChoose}</span>}
                </span>
                <span className="k">{S.data}</span><span className="v" style={{ fontSize: 13 }}><code>{system?.data_dir ?? "-"}</code></span>
                <span className="k">{S.workspace}</span>
                <span className="v" style={{ fontSize: 13 }}>{wsOn ? <code>{wsPath.trim() || S.defaultFolder}</code> : S.skipped}</span>
              </div>
            </section>
            {err && <Notice tone="neg" style={{ margin: "14px 0 0" }}>{S.createFailed(err)}</Notice>}
            {created && wsErr && (
              <Notice tone="warn" style={{ margin: "14px 0 0" }} action={
                <button type="button" className="btn" onClick={() => onCreated(created)} disabled={busy}>{S.skip}</button>
              }>
                {S.workspaceFailed(wsErr)}
              </Notice>
            )}
          </>
        )}

        <div className="controls" style={{ margin: "18px 0 0" }}>
          {step > 0 && !created && <button className="btn" onClick={() => setStep(step - 1)} disabled={busy}>{S.back}</button>}
          <span className="muted" style={{ fontSize: 12 }}>
            {S.stepOf(step + 1)}{step === 1 && S.picked(nModules(picked.size))}
          </span>
          <span className="spacer" />
          {step === 1 && !picked.size && <span className="muted" style={{ fontSize: 12 }}>{S.noModulesHint}</span>}
          {step === 2 && !privacy && <span className="muted" style={{ fontSize: 12 }}>{S.choosePrivacy}</span>}
          {step === 0 && <button className="btn primary" type="submit" form="wz-step">{S.next}</button>}
          {step === 1 && <button className="btn primary" onClick={() => setStep(2)}>{S.next}</button>}
          {step === 2 && (
            <button className="btn primary" onClick={create} disabled={busy || !privacy}>
              {created ? (busy ? S.creatingWorkspace : C.retry) : busy ? S.creatingProfile : S.createProfile}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
