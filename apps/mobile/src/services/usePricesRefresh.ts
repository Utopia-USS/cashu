// Keeps the current vault's market prices fresh while the Investments tab is in front: when the tab
// gains focus and when the app comes back to the foreground, at most every 5 minutes per vault after a
// run that reached the network (the Mac's UI cadence, `UI_PRICES_MS`); an offline run leaves the gate
// open for the next activation. A run that stored something records this phone's fetch time for that
// vault (`pricesFetchedAt`, per vault: a run fetches only the current vault's tickers) for the header's
// "fetched by this phone"; a run that reached the network but stored nothing (Yahoo throttling) closes
// the gate without claiming a fetch. Demo vaults come back "nothing" (`refreshPrices`).
// Mounted by the Investments tab layout with `enabled` = the investments module is on; renders nothing.
import { profileIdentity } from "@cashu/store/core/profile";
import { currentVault, setPricesFetchedAt } from "@cashu/store/device";
import { useCommand, useQuery } from "@cashu/store-react";
import { useIsFocused } from "expo-router";
import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";
import { localToday } from "../screens/screenContext";
import { refreshPrices } from "./prices";
import { createRatesGate } from "./ratesGate";
import { useServices } from "./ServicesProvider";

/** The Mac's UI price cadence (`apps/host/src/worker/service.ts` `UI_PRICES_MS`). */
const UI_PRICES_MS = 5 * 60_000;

/** One app, one price schedule. */
const gate = createRatesGate(UI_PRICES_MS);

export function usePricesRefresh({ enabled }: { readonly enabled: boolean }): void {
  const { prices, storeOf } = useServices();
  const vault = useQuery(currentVault);
  const profile = useQuery(profileIdentity);
  const focused = useIsFocused();
  const record = useCommand(setPricesFetchedAt);
  const fetched = useEffectEvent((at: string, of: string) => void record.run({ vault: of, at }));
  const baseCurrency = profile?.baseCurrency ?? "PLN";

  useEffect(() => {
    if (!enabled || !focused || vault === null) return;
    const run = () => {
      const started = Date.now();
      if (!gate.begin(vault, started)) return;
      void refreshPrices({
        store: storeOf(vault),
        prices,
        fetch: (url, init) => fetch(url, init),
        now: Date.now,
        // The day of this run: an activation runs before the screens re-render with the new day.
        today: localToday(),
        baseCurrency,
      }).then(
        (result) => {
          const offline = result.status === "offline";
          gate.finish(vault, started, offline);
          if (result.status === "ok" || result.updated > 0)
            fetched(new Date(started).toISOString(), vault);
        },
        () => gate.finish(vault, started, true),
      );
    };
    run();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => subscription.remove();
  }, [enabled, focused, vault, baseCurrency, prices, storeOf]);
}
