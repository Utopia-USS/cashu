// Root: loads the platform state (system, modules, profiles) and shows either the
// first-launch wizard (no profile yet) or the shell.
import { useCallback, useEffect, useState } from "react";
import { useAsync } from "../hooks";
import { Skeleton, SkeletonChart, SkeletonKpis, ToastProvider } from "../ui";
import { getModules, getProfiles, getSystem, type Profile } from "./api";
import { Shell } from "./Shell";
import { Wizard } from "./Wizard";

export function App() {
  return (
    <ToastProvider>
      <Root />
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
      setErr((e as Error).message);
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
