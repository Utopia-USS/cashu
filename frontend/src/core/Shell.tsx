// The shell: header with the profile switcher (Ustawienia live in its menu), module tab groups with the
// open module's action, and the page of the current view. Navigation state lives in the URL hash
// (#/{slug}/{view}) and the last view per profile is remembered.
import { Fragment, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAsync } from "../hooks";
import { ck, clearCache, swr } from "../swr";
import { SkeletonChart, SkeletonKpis, useToast } from "../ui";
import {
  getCategories, getNetworth, getSetup, getSummary, type ModuleInfo, type Profile, type SystemInfo,
} from "./api";
import { Brand } from "./Brand";
import { hideCard, isHidden, onHiddenChange } from "./hidden";
import { createReloadHold } from "./hold";
import { partialLine } from "./setupSteps";
import { Overview } from "./Overview";
import { ProfileMenu } from "./ProfileMenu";
import { moduleDef, orderModules, tabKey } from "./registry";
import { Settings } from "./Settings";
import { SetupPage } from "./SetupPage";
import { pathToView, type Shell as ShellState, ShellContext, viewToPath } from "./context";
import { useTheme } from "./theme";
import type { ModuleCtx, View } from "./types";
import { decodeSegment, resolveView } from "./util";
import { Wizard } from "./Wizard";
import { IconSheet } from "../widgets";
import { readStored } from "./storage";

const PROFILE_KEY = "cashu.profile";
const lastViewKey = (slug: string) => `cashu.lastView.${slug}`;
const store = {
  get: (k: string) => { try { return readStored(localStorage, k); } catch { return null; } },
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
  // A page can ask for the narrow frame (minimal profile); reset whenever the page changes.
  const [narrow, setNarrow] = useState(false);

  const profile = profiles.find((p) => p.slug === slug) ?? profiles[0];
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

  // Module states can change outside the app (CLI, Claude Code): re-read on focus, unless a Start page's drawer
  // holds the page (closing the native file chooser focuses the window too).
  const [hold] = useState(createReloadHold);
  useEffect(() => {
    const onFocus = () => { if (!hold.held()) void reloadProfiles(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadProfiles, hold]);

  // A newly created profile (first launch or wizard) arrives through initialSlug.
  useEffect(() => {
    if (initialSlug && initialSlug !== slug && profiles.some((p) => p.slug === initialSlug)) {
      setSlug(initialSlug);
      setView(OVERVIEW);
    }
  }, [initialSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  // The data cache (src/swr.ts) holds one profile at a time: a different slug clears it before any keyed hook
  // of this render reads it (idempotent, so safe to run on every render).
  swr.setScope(profile.slug);

  // Shared per-profile data, keyed by the slug: a keyed useAsync only shows data and errors of its own key
  // (never the previous profile's while the new ones load); a refresh keeps them visible while re-reading.
  const summaryS = useAsync(() => getSummary(profile.slug), [profile.slug, nonce], { key: ck(profile.slug, "summary") });
  const networthS = useAsync(() => getNetworth(profile.slug), [profile.slug, nonce], { key: ck(profile.slug, "networth") });
  const catsS = useAsync(() => getCategories(profile.slug), [profile.slug], { key: ck(profile.slug, "categories") });

  const go = useCallback((v: View, opts?: { scroll?: boolean }) => {
    setView(v);
    if (opts?.scroll !== false) window.scrollTo({ top: 0 });
  }, []);
  const askNarrow = useCallback((v: boolean) => setNarrow(v), []);
  // After a write: forget every cached view (the remounted pages read fresh data), then re-read.
  const refresh = useCallback(() => { clearCache(); setNonce((n) => n + 1); }, []);

  const switchProfile = (s: string) => {
    const p = profiles.find((x) => x.slug === s);
    if (!p) return;
    setSlug(s);
    setView(pathToView(store.get(lastViewKey(s)) ?? undefined) ?? OVERVIEW);
    toast(`Profil: ${p.name}`);
  };

  // Przegląd when the view points at a module that is off or unknown; a tab route of a module that lives on
  // Przegląd (no tabs, e.g. assets) -> Przegląd with its widget focused (core/util.ts resolveView).
  const resolved: View = resolveView(view, enabled, (id) => moduleDef(id, modules).tabs.map((t) => t.id));
  const tabless = (id: string) => !moduleDef(id, modules).tabs.length;

  // The open module's tabbar action (budget: bank sync).
  const activeMod = resolved.kind === "tab" && resolved.tab !== "overview" ? resolved.tab.split(".")[0] : null;
  const TabAction = activeMod ? moduleDef(activeMod, modules).TabAction : undefined;

  const shell: ShellState = {
    slug: profile.slug, profile, profiles, system, modules, view: resolved, go,
    reloadProfiles, hold, openWizard: () => setWizard(true), setNarrow: askNarrow, refresh,
  };

  // Przegląd (widget grid) and workspace tabs (investments) use the wide page; everything else keeps
  // Kuba's 1120 px; a page may ask for the narrow frame (minimal profile).
  const wide = (() => {
    if (resolved.kind !== "tab") return false;
    if (resolved.tab === "overview") return true;
    const [mid, tid] = resolved.tab.split(".");
    return !!moduleDef(mid, modules).tabs.find((t) => t.id === tid)?.wide;
  })();

  const loadError = summaryS.error || networthS.error || catsS.error;
  const ready = summaryS.data && networthS.data && catsS.data;

  const page = (() => {
    if (resolved.kind === "settings") return <Settings section={resolved.section} theme={pref} setTheme={setPref} />;
    if (!ready) return <><SkeletonKpis /><SkeletonChart /></>;
    const base: Omit<ModuleCtx, "state"> = {
      slug: profile.slug, profile, summary: summaryS.data!, networth: networthS.data!, categories: catsS.data!, go, refresh,
      sub: resolved.kind === "tab" ? resolved.sub : undefined,
    };
    if (resolved.kind === "tab" && resolved.tab === "overview") return <Overview base={base} enabled={enabled} />;
    // The in-app first steps (`setup/<module>`) of a module that has them; the CLI / Claude Code page otherwise and
    // at `setup/<module>/cli` (design/v3/first-steps D1).
    if (resolved.kind === "setup") {
      const pm = enabled.find((m) => m.id === resolved.module)!;
      const def = moduleDef(pm.id, modules);
      return def.Start && !resolved.cli
        ? <def.Start ctx={{ ...base, state: pm.setup_state }} />
        : <SetupPage moduleId={pm.id} state={pm.setup_state} />;
    }
    const [mid, tid] = resolved.tab.split(".");
    const pm = enabled.find((m) => m.id === mid)!;
    const def = moduleDef(mid, modules);
    const tab = def.tabs.find((t) => t.id === tid)!;
    // An enabled module with no data yet: its first tab is the module's first steps (Start), else the blank page
    // (SetupPage). A partial module shows its data with a strip that leads back to the remaining steps.
    const first = tab === def.tabs[0];
    if (first && !def.ownSetup && (pm.setup_state === "empty" || (def.setupUntilReady && pm.setup_state !== "ready"))) {
      return def.Start ? <def.Start ctx={{ ...base, state: pm.setup_state }} /> : <SetupPage moduleId={mid} state={pm.setup_state} />;
    }
    const body = tab.render({ ...base, state: pm.setup_state });
    if (body == null) return <SetupPage moduleId={mid} state={pm.setup_state} />;
    return <>{first && !def.ownSetup && pm.setup_state === "partial" && <PartialStrip moduleId={mid} name={def.name} state={pm.setup_state} />}{body}</>;
  })();

  return (
    <ShellContext.Provider value={shell}>
      <IconSheet />
      <div className={`wrap ${narrow ? "narrow" : wide ? "wide" : ""}`} aria-hidden={wizard || undefined}>
        <header className="shell">
          <div className="brand">
            <Brand />
            <ProfileMenu profiles={profiles} active={profile}
              onSelect={switchProfile} onNew={() => setWizard(true)}
              onSettings={() => go({ kind: "settings" })} />
          </div>
          <div className="hdr-right">
            {enabled.filter((m) => m.setup_state !== "empty").map((m) => {
              const Tag = moduleDef(m.id, modules).HeaderTag;
              return Tag ? <Tag key={`${profile.slug}:${m.id}:${nonce}`} slug={profile.slug} go={go} /> : null;
            })}
          </div>
        </header>

        {loadError && <div className="err">Błąd: {loadError}</div>}

        <nav className="tabbar" aria-label="Moduły">
          {/* The setup page of a module that lives on Przegląd keeps Przegląd lit. */}
          <button className={`tabbtn ${(resolved.kind === "tab" && resolved.tab === "overview") || (resolved.kind === "setup" && tabless(resolved.module)) ? "on" : ""}`}
            onClick={() => go(OVERVIEW)}>Przegląd</button>
          {enabled.filter((m) => !tabless(m.id)).map((m) => {
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
                      title={dot ? "Nieskonfigurowany" : undefined}>
                      {t.label}{dot && <span className="dot" aria-label="nieskonfigurowany" />}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
          <span className="spacer" />
          {TabAction && <TabAction key={profile.slug} slug={profile.slug} profileName={profile.name} networth={networthS.data ?? null} refresh={refresh} />}
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

/** One quiet line on the first tab of a partially set up module: `{Moduł} · 2 z 3 kroków · następny: …`, `Kontynuuj`
 * (the module's first steps) and `ukryj` (until the setup state changes; shared with the Przegląd ghost card). */
function PartialStrip({ moduleId, name, state }: { moduleId: string; name: string; state: string }) {
  const { slug, go } = useContext(ShellContext)!;
  const { data } = useAsync(() => getSetup(slug, moduleId), [slug, moduleId], { key: ck(slug, "setup", moduleId) });
  const [, rerender] = useState(0);
  useEffect(() => onHiddenChange(() => rerender((n) => n + 1)), []);
  if (isHidden(slug, moduleId, state)) return null;
  return (
    <div className="notice">
      <div className="grow"><b>{name}</b>{data ? ` · ${partialLine(data.steps)}` : ""}</div>
      <button className="btn sm primary" onClick={() => go({ kind: "setup", module: moduleId })}>Kontynuuj</button>
      <button className="lnk" onClick={() => hideCard(slug, moduleId, state)}>ukryj</button>
    </div>
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
