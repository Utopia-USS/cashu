// Section hook of Ustawienia › Konektory: the profile's connector runs and its bindings' sync state as one live
// device query (re-pushed when a run is recorded or a binding's fetch state moves). Composed by useSettingsScreen.
import { connectorActivity } from "@cashu/store/core/desktop-settings";
import { useQuery } from "@cashu/store-react";

export function useConnectorActivity(vault: string) {
  return useQuery(connectorActivity, { vault, privacy: false });
}
