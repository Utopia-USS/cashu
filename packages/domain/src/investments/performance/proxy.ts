/**
 * The strategy's benchmark proxy as a reference instrument (port of the pure part of
 * `performance/proxy.py`). A strategy names its benchmark by a market symbol (`IUSQ.DE`) the owner
 * often neither holds nor watches; `referenceInstrument` plans the instrument such a symbol names when
 * its market suffix is known (the Yahoo / stooq conventions of broker imports), so the store can
 * register it offline. Registering it and the `is_reference_only` check are the store's.
 */

import { pyStrip, pyUpper } from "../../text.js";
import {
  AliasNamespace,
  type Instrument,
  instrument,
  instrumentAlias,
} from "../domain/instrument.js";
import { asInstrumentId } from "../domain/values.js";
import { splitBrokerSymbol, stooqSymbol, yahooSymbol } from "../importing/exchanges.js";
import { guessAssetClass } from "../importing/resolver.js";
import { isIsin } from "./service.js";

/** Placeholder id of a planned reference instrument (the store assigns the real one). */
export const PLANNED_PROXY_ID = asInstrumentId("benchmark-proxy");

/**
 * `proxy.reference_instrument`: the planned reference instrument of a market symbol with a known
 * market suffix (`IUSQ.DE` -> IUSQ on Xetra, EUR, guessed yahoo `IUSQ.DE`, guessed stooq `iusq.de`),
 * else null (an ISIN, no suffix, an unknown or crypto market).
 */
export function referenceInstrument(proxy: string | null): Instrument | null {
  const text = pyStrip(proxy ?? "");
  if (text === "" || isIsin(text)) return null;
  const split = splitBrokerSymbol(text, null);
  const market = split.exchange;
  if (market === null || market.currency === null || market.crypto) return null;
  const ticker = pyUpper(pyStrip(split.symbol));
  const yahoo = ticker === "" ? null : yahooSymbol(market, ticker);
  if (ticker === "" || !yahoo) return null;
  const aliases = [instrumentAlias(AliasNamespace.YAHOO, yahoo, true)];
  const stooq = stooqSymbol(market, ticker);
  if (stooq) aliases.push(instrumentAlias(AliasNamespace.STOOQ, stooq, true));
  return instrument({
    id: PLANNED_PROXY_ID,
    name: yahoo,
    currency: market.currency,
    assetClass: guessAssetClass(ticker, ticker, market),
    symbol: ticker,
    mic: market.mic,
    aliases,
  });
}
