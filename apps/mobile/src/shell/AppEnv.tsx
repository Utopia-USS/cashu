// The app environment below the profile: privacy mode and the banana scale for every packages/ui
// component (UiEnvProvider), the ui-logic incognito mirror, the last-open stamp, the NBP rate refresh
// (W3c's `useRatesRefresh`), the first-run pairing route, the app lock's gate, the pairing's hold over the
// services' reopen and the app-switcher cover over the whole app.
import { useQuery } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ReactNode } from "react";
import { useServices } from "../services/ServicesProvider";
import { useRatesRefresh } from "../services/useRatesRefresh";
import { LockGate } from "./LockGate";
import { PairingHold } from "./PairingHold";
import { PrivacyCover } from "./PrivacyCover";
import { usePairingRoute } from "./pairingRoute";
import { useIncognito, useIncognitoMirror, useLastOpened } from "./useAppEnv";
import { useNow } from "./useNow";

export function AppEnv({ children }: { children: ReactNode }) {
  const { moneyQueries } = useServices();
  const incognito = useIncognito();
  const { today } = useNow();
  const bananas = useQuery(moneyQueries.overview.bananaScale, { today });
  useIncognitoMirror(incognito.on);
  useLastOpened();
  useRatesRefresh(today);
  usePairingRoute();
  return (
    <UiEnvProvider privacy={incognito.on} bananas={bananas}>
      <LockGate>{children}</LockGate>
      <PairingHold />
      <PrivacyCover />
    </UiEnvProvider>
  );
}
