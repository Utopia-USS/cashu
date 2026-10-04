// The shell: header with the profile switcher, module tab groups, Ustawienia, and the
// page of the current view. Navigation state lives in the URL hash
// (#/{slug}/{view}) and the last view per profile is remembered.
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { nAccounts, nModules } from "../format";
import { useAsync } from "../hooks";
import { Notice, SkeletonChart, SkeletonKpis, useToast } from "../ui";
import {
  getCategories, getNetworth, getSetup, getSummary, type ModuleInfo, postResync, type Profile, type SystemInfo,
} from "./api";
import { Overview } from "./Overview";
import { ProfileMenu } from "./ProfileMenu";
import { moduleDef, orderModules, tabKey } from "./registry";
import { Settings } from "./Settings";
import { SetupPage } from "./SetupPage";
import { pathToView, type Shell as ShellState, ShellContext, viewToPath } from "./context";
import { useTheme } from "./theme";
import type { ModuleCtx, View } from "./types";
import { decodeSegment } from "./util";
import { Wizard } from "./Wizard";

const PROFILE_KEY = "finanse.profile";
const lastViewKey = (slug: string) => `finanse.lastView.${slug}`;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const OVERVIEW: View = { kind: "tab", tab: "overview" };

function parseHash(): { slug?: string; view: View | null } {
  const m = location.hash.match(/^#\/([^/]+)(?:\/(.*))?$/);
  if (!m) return { view: null };
  // A malformed escape (typo, truncated link) is read as "no profile in the URL"
  // instead of throwing during render and blanking the page.
  const slug = decodeSegment(m[1]);
  if (slug === null) return { view: null };
  return { slug, view: pathToView(m[2]) };
}

export function Shell({ profiles, system, modules, reloadProfiles, initialSlug }: {
  profiles: Profile[];
  system: SystemInfo | null;
  modules: ModuleInfo[];
  reloadProfiles: () => Promise<void>;
  initialSlug: string | null;
}) {
  const toast = useToast();
  const { pref, setPref, version: themeVersion } = useTheme();

  const pickSlug = (want?: string | null) =>
    (want && profiles.some((p) => p.slug === want) ? want : null)
    ?? (profiles.some((p) => p.slug === store.get(PROFILE_KEY)) ? store.get(PROFILE_KEY)! : profiles[0].slug);

  const [slug, setSlug] = useState(() => pickSlug(initialSlug ?? parseHash().slug));
  const [view, setView] = useState<View>(() => {
    const h = parseHash();
    if (!initialSlug && h.slug === slug && h.view) return h.view;
    return initialSlug ? OVERVIEW : pathToView(store.get(lastViewKey(slug)) ?? undefined) ?? OVERVIEW;
  });
  const [wizard, setWizard] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Profiles whose resync is running: a sync belongs to the profile it was started for.
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const profile = profiles.find((p) => p.slug === slug) ?? profiles[0];
  const activeSlug = useRef(profile.slug);
  activeSlug.current = profile.slug;
  const enabled = useMemo(() => orderModules(profile.modules.filter((m) => m.enabled)), [profile]);

  // URL hash + last view per profile follow the state.
  useEffect(() => {
    const path = viewToPath(view);
    const hash = `#/${encodeURIComponent(profile.slug)}/${path}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    store.set(PROFILE_KEY, profile.slug);
    store.set(lastViewKey(profile.slug), path);
  }, [profile.slug, view]);

  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (h.slug && h.slug !== slug && profiles.some((p) => p.slug === h.slug)) setSlug(h.slug);
      if (h.view) setView(h.view);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [slug, profiles]);

  // Module states can change outside the app (CLI, Claude Code): re-read on focus.
  useEffect(() => {
    const onFocus = () => { void reloadProfiles(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadProfiles]);

  // A newly created profile (first launch or wizard) arrives through initialSlug.
  useEffect(() => {
    if (initialSlug && initialSlug !== slug && profiles.some((p) => p.slug === initialSlug)) {
      setSlug(initialSlug);
      setView(OVERVIEW);
    }
  }, [initialSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared per-profile data. Results AND errors are tagged with the slug, so a profile
  // switch never renders the previous profile's numbers or error banner while the new
  // ones load (useAsync keeps stale data).
  type Tagged<T> = { s: string; d: T | null; e: string | null };
  const tag = <T,>(s: string, p: Promise<T>): Promise<Tagged<T>> =>
    p.then((d) => ({ s, d, e: null }), (e: Error) => ({ s, d: null, e: e.message }));
  const summaryQ = useAsync(() => tag(profile.slug, getSummary(profile.slug)), [profile.slug, nonce]);
  const networthQ = useAsync(() => tag(profile.slug, getNetworth(profile.slug)), [profile.slug, nonce]);
  const catsQ = useAsync(() => tag(profile.slug, getCategories(profile.slug)), [profile.slug]);
  const own = <T,>(q: { data: Tagged<T> | null; error: string | null }) => {
    const mine = q.data?.s === profile.slug ? q.data : null;
    return { data: mine?.d ?? null, error: mine?.e ?? q.error };
  };
  const summaryS = own(summaryQ), networthS = own(networthQ), catsS = own(catsQ);

  const go = useCallback((v: View) => { setView(v); window.scrollTo({ top: 0 }); }, []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const switchProfile = (s: string) => {
    const p = profiles.find((x) => x.slug === s);
    if (!p) return;
    setSlug(s);
    setView(pathToView(store.get(lastViewKey(s)) ?? undefined) ?? OVERVIEW);
    setSyncMsg(null); setErr(null);
    toast(`Profil: ${p.name}`);
  };

  // Fall back to Przegląd when the view points at a module that is off or unknown.
  const resolved: View = (() => {
    if (view.kind === "settings") return view;
    if (view.kind === "setup") return enabled.some((m) => m.id === view.module) ? view : OVERVIEW;
    if (view.tab === "overview") return view;
    const [mid, tid] = view.tab.split(".");
    const pm = enabled.find((m) => m.id === mid);
    if (!pm || !moduleDef(mid, modules).tabs.some((t) => t.id === tid)) return OVERVIEW;
    return view;
  })();

  const bankAccounts = (networthS.data?.accounts ?? []).filter((a) => a.bank !== "manual" && a.type !== "cash");
  const budgetOn = enabled.some((m) => m.id === "budget");

  const resync = async () => {
    const s = profile.slug, name = profile.name;
    const here = () => activeSlug.current === s; // still on the profile the sync is for?
    setSyncing((cur) => new Set(cur).add(s)); setErr(null); setSyncMsg(null);
    try {
      const res = await postResync(s);
      let msg: string;
      if (!res.ok) msg = res.error || "Synchronizacja nieudana.";
      else {
        msg = `wgrano ${res.inserted} nowych transakcji`;
        if (res.pairs) msg += `, ${res.pairs} przelewów wewn.`;
        if (res.errors?.length) msg += ` · ${res.errors.length} konto/a pominięte (limit banku)`;
      }
      // The header shows the result only on its own profile; elsewhere a toast names it.
      if (!here()) toast(`${name}: ${msg}`, 5000);
      else if (!res.ok) setErr(msg);
      else { setSyncMsg(msg); refresh(); }
    } catch (e) {
      if (here()) setErr((e as Error).message);
      else toast(`${name}: ${(e as Error).message}`, 5000);
    } finally {
      setSyncing((cur) => { const next = new Set(cur); next.delete(s); return next; });
    }
  };
  const syncingHere = syncing.has(profile.slug);

  const asof = networthS.data?.accounts.map((a) => a.as_of).filter(Boolean).sort().slice(-1)[0];
  const modCount = nModules(enabled.length);
  const sub = syncMsg ? `${syncMsg} · odświeżono`
    : !networthS.data ? "ładowanie…"
    : asof ? `ostatnie dane: ${asof} · ${modCount}` : `brak danych · ${modCount}`;

  const shell: ShellState = {
    slug: profile.slug, profile, profiles, system, modules, view: resolved, go,
    reloadProfiles, openWizard: () => setWizard(true),
  };

  const loadError = summaryS.error || networthS.error || catsS.error;
  const ready = summaryS.data && networthS.data && catsS.data;

  const page = (() => {
    if (resolved.kind === "settings") return <Settings section={resolved.section} theme={pref} setTheme={setPref} />;
    if (!ready) return <><SkeletonKpis /><SkeletonChart /></>;
    const base: Omit<ModuleCtx, "state"> = {
      slug: profile.slug, profile, summary: summaryS.data!, networth: networthS.data!, categories: catsS.data!, go, refresh,
    };
    if (resolved.kind === "tab" && resolved.tab === "overview") return <Overview base={base} enabled={enabled} />;
    if (resolved.kind === "setup") {
      const pm = enabled.find((m) => m.id === resolved.module)!;
      return <SetupPage moduleId={pm.id} state={pm.setup_state} />;
    }
    const [mid, tid] = resolved.tab.split(".");
    const pm = enabled.find((m) => m.id === mid)!;
    const def = moduleDef(mid, modules);
    const tab = def.tabs.find((t) => t.id === tid)!;
    // An enabled module with no data yet: its first tab is the blank page (SetupPage).
    // A partial module shows its data with a strip that leads back to the remaining steps.
    const first = tab === def.tabs[0];
    if (first && (pm.setup_state === "empty" || (def.setupUntilReady && pm.setup_state !== "ready"))) {
      return <SetupPage moduleId={mid} state={pm.setup_state} />;
    }
    const body = tab.render({ ...base, state: pm.setup_state });
    if (body == null) return <SetupPage moduleId={mid} state={pm.setup_state} />;
    return <>{first && pm.setup_state === "partial" && <PartialStrip moduleId={mid} name={def.name} />}{body}</>;
  })();

  return (
    <ShellContext.Provider value={shell}>
      <div className="wrap" aria-hidden={wizard || undefined}>
        <header>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1>finanse</h1>
              <ProfileMenu profiles={profiles} active={profile} activeNetworth={networthS.data}
                onSelect={switchProfile} onNew={() => setWizard(true)}
                onSettings={() => go({ kind: "settings", section: "profile" })} />
            </div>
            <div className="sub">{sub}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {networthS.data && <span className="tag">{nAccounts(networthS.data.accounts.length)}</span>}
            {budgetOn && (
              <button className="btn" onClick={resync} disabled={syncingHere || !bankAccounts.length}
                title={bankAccounts.length ? "Pobierz nowe transakcje z banków (Enable Banking)" : "Brak kont bankowych do synchronizacji"}>
                {syncingHere ? "Synchronizuję…" : "↻ Synchronizuj"}
              </button>
            )}
          </div>
        </header>

        {(err || loadError) && <div className="err">Błąd: {err || loadError}</div>}

        <nav className="tabbar" aria-label="Moduły">
          <button className={`tabbtn ${resolved.kind === "tab" && resolved.tab === "overview" ? "on" : ""}`} onClick={() => go(OVERVIEW)}>Przegląd</button>
          {enabled.map((m) => {
            const def = moduleDef(m.id, modules);
            const pending = m.setup_state !== "ready";
            return (
              <Fragment key={m.id}>
                <span className="tabsep" aria-hidden />
                {def.tabs.map((t, i) => {
                  const key = tabKey(m.id, t.id);
                  const on = (resolved.kind === "tab" && resolved.tab === key) || (i === 0 && resolved.kind === "setup" && resolved.module === m.id);
                  const dot = pending && i === 0;
                  return (
                    <button key={key} className={`tabbtn ${on ? "on" : ""}`} onClick={() => go({ kind: "tab", tab: key })}
                      title={dot ? "Moduł włączony, ale nieskonfigurowany" : undefined}>
                      {t.label}{dot && <span className="dot" aria-label="nieskonfigurowany" />}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
          <span className="spacer" />
          <button className={`tabbtn ${resolved.kind === "settings" ? "on" : ""}`} onClick={() => go({ kind: "settings" })}>Ustawienia</button>
        </nav>

        {/* Remount per profile, refresh and theme change (charts read tokens at render);
            Settings has no charts and keeps its scroll position when the theme changes there. */}
        <div key={resolved.kind === "settings" ? `${profile.slug}:settings` : `${profile.slug}:${nonce}:${themeVersion}`}>{page}</div>
      </div>

      {wizard && (
        <WizardOverlay
          system={system} modules={modules} existing={profiles}
          onCancel={() => { setWizard(false); toast("Przerwano tworzenie profilu"); }}
          onCreated={async (p) => {
            await reloadProfiles();
            setWizard(false);
            setSlug(p.slug);
            setView(OVERVIEW);
            toast(`Profil: ${p.name}`);
          }} />
      )}
    </ShellContext.Provider>
  );
}

/** Compact reminder on the first tab of a partially set up module. */
function PartialStrip({ moduleId, name }: { moduleId: string; name: string }) {
  const { slug, go } = useContext(ShellContext)!;
  const { data } = useAsync(() => getSetup(slug, moduleId), [slug, moduleId]);
  const next = data?.steps.find((s) => s.status === "on") ?? data?.steps.find((s) => s.status !== "done");
  return (
    <Notice tone="warn" action={<button className="btn" onClick={() => go({ kind: "setup", module: moduleId })}>Kontynuuj konfigurację</button>}>
      <b>{name}: konfiguracja niedokończona.</b>{next ? ` Następny krok: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.` : ""}
    </Notice>
  );
}

function WizardOverlay(props: {
  system: SystemInfo | null; modules: ModuleInfo[]; existing: Profile[];
  onCancel: () => void; onCreated: (p: Profile) => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    // No close on scrim click: a stray click must not throw away a half-filled profile (Esc / ✕ do).
    <div className="overlay">
      <Wizard firstLaunch={false} {...props} />
    </div>
  );
}
