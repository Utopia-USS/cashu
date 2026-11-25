// The investments header tag (ab24ab6 v2/Overview.tsx InvestmentsHeaderTag, ia-v2.md 10): the count of stale prices
// in the shell header, only when there are some; it opens the investments Home on Alokacja's Rachunki view. The
// price refresh itself (old usePriceRefresh, every 15 minutes while the app is visible) is the host worker's: it
// refreshes prices while a UI is connected, so the renderer drives nothing.
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/Overview.strings";
import { investmentDesktopQueries } from "@cashu/store/investments/screen";
import { useQuery } from "@cashu/store-react";
import { dm } from "@cashu/ui-logic/investments/labels";
import { overviewOf } from "../screens/investments/home/homeAdapters.js";
import { useCalendarDay } from "./useCalendarDay.js";

const portfolio = investmentDesktopQueries();

export interface InvestmentsHeaderTagState {
  /** Null = no stale prices: nothing shows. */
  tag: { text: string; title: string } | null;
  onOpen(): void;
}

export function useInvestmentsHeaderTag(onOpen: () => void): InvestmentsHeaderTagState {
  const today = useCalendarDay();
  // The Home's unfiltered 1y read (one cache entry with the Home and Przegląd), old getOverviewV2(slug).
  const p1y = useQuery(portfolio.portfolio, {
    today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    account: null,
    range: "1y",
  });
  const fr = overviewOf(p1y).data?.freshness.prices;
  return {
    tag: fr?.stale_count
      ? {
          text: S.stalePrices(fr.stale_count),
          title: fr.stale
            .map((x) => `${x.label}: ${x.price_date ? S.lastQuote(dm(x.price_date)) : S.noQuotes}`)
            .join("\n"),
        }
      : null,
    onOpen,
  };
}
