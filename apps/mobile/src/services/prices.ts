// Market prices on the phone: the daily closes of the vault's held and watched instruments from Yahoo
// (stooq is bot-blocked since 2026-10) and the NBP rates their currencies need, into this device's
// price cache (device-local, never synced). Yahoo sees the vault's ticker list and NBP the currency
// codes; nothing else leaves the phone. Only the cache is written: no vault event, no lease report
// (alerts and rules still run on the Mac, the leader). The demo vaults are never refreshed.
import { type DateTime, type IsoDate, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import { NbpFxSource } from "@cashu/market/nbp";
import { type FetchLike, MarketHttp, YahooPriceSource } from "@cashu/market/yahoo";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import { collectPriceNeeds, refreshPriceNeeds } from "@cashu/store/investments/prices";
import type { Store } from "@cashu/store/runtime";
import { isDemoVault } from "./demo";

/** Per request, connect plus the whole body. */
const TIMEOUT_MS = 10_000;

export interface PricesRefresh {
  /**
   * "ok": every request answered; "partial": the network was reached but some or all requests failed
   * (an HTTP error such as 429 / 401 / 403 / 5xx, a blocked source), so the 5-minute gate still closes;
   * "offline": no request reached a server (a transport TypeError or a timeout abort; the cache is
   * untouched); "nothing": the vault holds and watches nothing priced, or it is a demo vault.
   */
  readonly status: "ok" | "partial" | "offline" | "nothing";
  /** Instruments that got new bars. */
  readonly updated: number;
  readonly errors: readonly string[];
}

/**
 * `fetch` with a 10 s limit on the request and its body; the timer is cleared either way. `answered`
 * becomes true once any server answered with a whole body, whatever its HTTP status: only transport
 * failures (TypeError) and the timeout's AbortError leave a run `offline`.
 */
function timed(fetch: FetchLike, net: { answered: boolean }): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      net.answered = true;
      return { status: response.status, headers: response.headers, text: async () => text };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fetches what the vault of `store` needs (held and watched instruments with a Yahoo alias, their
 * currencies' NBP rates) up to `today` into `prices`. Never throws: a run that reached no server is
 * `offline`.
 */
export async function refreshPrices(deps: {
  readonly store: Store;
  readonly prices: SqlPriceCache;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly today: IsoDate;
  readonly baseCurrency: string;
}): Promise<PricesRefresh> {
  const stamp = (): DateTime => parseDateTime(new Date(deps.now()).toISOString());
  const read = deps.store.read.bind(deps.store);
  const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
  if (vault === undefined) return { status: "nothing", updated: 0, errors: [] };
  // TRANSITIONAL(S44): a real close would contradict the demo's story and seam every chart.
  if (isDemoVault(vault)) return { status: "nothing", updated: 0, errors: [] };
  const needs = collectPriceNeeds(read, deps.today, stamp(), toCurrency(deps.baseCurrency));
  const priced = [...needs.instruments.values(), ...needs.watched.values()].some(
    (i) => market.marketSymbolsOf(i).length > 0,
  );
  if (!priced && [...needs.currencies].every((c) => c === deps.baseCurrency))
    return { status: "nothing", updated: 0, errors: [] };
  const net = { answered: false };
  const failed = (): "partial" | "offline" => (net.answered ? "partial" : "offline");
  const http = new MarketHttp({
    fetch: timed(deps.fetch, net),
    // The phone tries again at the next activation instead of waiting here.
    maxRetries: 0,
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    clock: () => deps.now() / 1000,
    timeoutSignal: () => undefined,
  });
  const yahoo = new YahooPriceSource(http, { clock: stamp });
  const nbp = new NbpFxSource(http, { clock: stamp });
  try {
    const result = await refreshPriceNeeds({
      vaults: [{ vault, needs, authority: { isHolder: () => true } }],
      prices: deps.prices,
      priceSource: yahoo,
      fxSource: nbp,
      spark: yahoo,
      tableFx: nbp,
      asOf: deps.today,
      now: stamp(),
      includeFxHistory: false,
    });
    const report = result.reports.get(vault);
    if (report === undefined) return { status: failed(), updated: 0, errors: [] };
    const ok = market.FetchStatus.OK;
    const updated = report.instruments.filter((i) => i.status === ok && i.bars.length > 0).length;
    const fxUpdated = report.fx.filter((f) => f.status === ok && f.rates.length > 0).length;
    const errors = market.reportErrorMessages(report);
    const status = errors.length === 0 ? "ok" : updated + fxUpdated === 0 ? failed() : "partial";
    return { status, updated, errors };
  } catch (error) {
    return { status: failed(), updated: 0, errors: [String(error)] };
  }
}
