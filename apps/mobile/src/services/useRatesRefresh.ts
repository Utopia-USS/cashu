// Keeps this device's NBP rates current for the converted net worth: on launch, when the app comes
// back to the foreground, and when the current vault uses a new currency; at most once an hour per
// currency set after a run that reached NBP (`ratesGate`). Mounted once in the app environment;
// renders nothing.
import type { IsoDate } from "@cashu/domain";
import { useQuery } from "@cashu/store-react";
import { useEffect } from "react";
import { AppState } from "react-native";
import { localToday } from "../screens/screenContext";
import { refreshRates } from "./rates";
import { createRatesGate } from "./ratesGate";
import { useServices } from "./ServicesProvider";

/** One app, one refresh schedule. */
const gate = createRatesGate();

export function useRatesRefresh(today: IsoDate): void {
  const { prices, moneyQueries } = useServices();
  const budget = useQuery(moneyQueries.budget.currencies, { today });
  const accounts = useQuery(moneyQueries.holdings.accounts, { today });
  const currencies = [
    ...new Set([...budget.currencies.map((c) => c.currency), ...accounts.map((a) => a.currency)]),
  ]
    .filter((c) => c !== "PLN")
    .sort();
  const key = currencies.join(",");

  useEffect(() => {
    if (key === "") return;
    const run = () => {
      const started = Date.now();
      if (!gate.begin(key, started)) return;
      void refreshRates({
        prices,
        fetch: (url, init) => fetch(url, init),
        now: Date.now,
        // The day of this run: an activation runs before the screens re-render with the new day.
        today: localToday(),
        currencies: key.split(","),
      }).then(
        (result) => gate.finish(key, started, result.skipped === "offline"),
        () => gate.finish(key, started, true),
      );
    };
    run();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => subscription.remove();
  }, [key, prices]);
}
