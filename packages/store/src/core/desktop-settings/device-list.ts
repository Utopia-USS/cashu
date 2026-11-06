// Ustawienia > Urządzenia: this vault's devices (registry, gate evidence, leader liveness, key provenance, recent
// operations) as one live vault query. The list is the native vault session's in-memory sync state, not a SQL
// view: the host checks it in the session queue and re-pushes it after every sync pass and every device change
// (a revocation, a leader pin, a pairing), so the screen never reads it again on its own. The value is the host
// protocol's device list; the renderer validates it with that schema.
import { type ChangeSource, defineQuery } from "../../query.js";

export type DeviceListState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly list: unknown };

/** The host's per-vault device lists. */
export interface DeviceListSource {
  /** Fires when a vault's list was checked again. */
  readonly changes: ChangeSource;
  state(vault: string): DeviceListState;
}

/** The live device list; unbound (no native host) it answers unavailable, and so does the owner's privacy mode. */
export function deviceListQuery(source?: DeviceListSource) {
  return defineQuery({
    id: "core.settings.deviceList",
    ...(source === undefined ? {} : { changes: source.changes }),
    run(read, args: { readonly privacy: boolean }): DeviceListState {
      if (args.privacy || source === undefined) return { status: "unavailable" };
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      return vault === undefined ? { status: "unavailable" } : source.state(vault);
    },
  });
}

/** The query the renderer names (`useQuery(deviceListState, { privacy })`); the host serves its bound twin. */
export const deviceListState = deviceListQuery();
