// Root: loads the platform state (system, modules, profiles) and shows either the
// first-launch wizard (no profile yet) or the shell.
import { useCallback, useEffect, useState } from "react";
import { useAsync } from "../hooks";
import { Notice, Skeleton, SkeletonChart, SkeletonKpis, ToastProvider } from "../ui";
import { getModules, getProfiles, getSystem, onAuthLost, type Profile } from "./api";
import { Shell } from "./Shell";
import { UpdateNotice } from "./UpdateNotice";
import { Wizard } from "./Wizard";
import { errorText } from "./messages";

/** The pywebview desktop window (finanse app), not a browser tab. */
const inDesktop = () => typeof window !== "undefined" && "pywebview" in window;

export function App() {
  const [authLost, setAuthLost] = useState(false);
  useEffect(() => onAuthLost(() => setAuthLost(true)), []);
  return (
    <ToastProvider>
      {authLost && (
        <div className="wrap" style={{ paddingBottom: 0 }}>
          {/* The desktop window gets the new token on reload; a browser tab needs the new #token= URL (PK1). */}
          {inDesktop() ? (
            <Notice tone="warn" action={<button className="btn primary" onClick={() => location.reload()}>Odśwież</button>}>
              <b>Serwer uruchomiony ponownie.</b> Odśwież stronę.
            </Notice>
          ) : (
            <Notice tone="warn"><b>Serwer uruchomiony ponownie.</b> Otwórz nowy adres z <code>finanse serve</code>.</Notice>
          )}
        </div>
      )}
      <Root />
      <UpdateNotice />
    </ToastProvider>
  );
}

function Root() {
  const system = useAsync(getSystem, []);
  const modules = useAsync(getModules, []);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const reloadProfiles = useCallback(async () => {
    try {
      setProfiles(await getProfiles());
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);
  useEffect(() => { void reloadProfiles(); }, [reloadProfiles]);

  const loadError = err || modules.error;
  if (loadError && (!profiles || !modules.data)) {
    return <div className="wrap"><div className="err">Błąd: {loadError}</div></div>;
  }
  if (!profiles || !modules.data) {
    return (
      <div className="wrap">
        <header><div><Skeleton w={150} h={24} /><Skeleton w={220} h={12} style={{ marginTop: 8 }} /></div></header>
        <Skeleton w="100%" h={40} style={{ margin: "0 0 20px" }} />
        <SkeletonKpis />
        <SkeletonChart />
      </div>
    );
  }
  if (!profiles.length) {
    return (
      <div className="wrap">
        <Wizard firstLaunch system={system.data} modules={modules.data} existing={[]}
          onCreated={async (p) => { setCreated(p.slug); await reloadProfiles(); }} />
      </div>
    );
  }
  return (
    <Shell profiles={profiles} system={system.data} modules={modules.data}
      reloadProfiles={reloadProfiles} initialSlug={created} />
  );
}
