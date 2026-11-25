// The one source of a profile's display name on the phone: the profile as its vault holds it now (live:
// a paired vault's first sync brings the name after the services opened), else the name the services
// read at boot (`pairedVaults`' stored name, "New profile" before the first sync). The header, the
// profile sheet and the lock screen all read it, so they never disagree after a pairing.
import { profileIdentity } from "@cashu/store/core/profile";
import { useStoreClient } from "@cashu/store-react";
import { useSyncExternalStore } from "react";
import { useServices } from "../services/ServicesProvider";

/** Each profile's display name now, by vault. */
export function useProfileNames(): ReadonlyMap<string, string> {
  const client = useStoreClient();
  const { profiles } = useServices();
  const entries = profiles.map(
    (p) =>
      [p, client.entry({ kind: "vault", vault: p.vault }, profileIdentity, undefined)] as const,
  );
  const subscribe = (onChange: () => void) => {
    const offs = entries.map(([, entry]) => entry.subscribe(onChange));
    return () => {
      for (const off of offs) off();
    };
  };
  // A string snapshot: equal names compare equal, so an unrelated store change renders nothing.
  const snapshot = () =>
    JSON.stringify(
      entries.map(([p, entry]) => {
        const state = entry.getSnapshot();
        return (state.status === "value" ? state.value?.name : undefined) ?? p.name;
      }),
    );
  const names = JSON.parse(useSyncExternalStore(subscribe, snapshot, snapshot)) as string[];
  return new Map(profiles.map((p, i) => [p.vault, names[i] ?? p.name]));
}
