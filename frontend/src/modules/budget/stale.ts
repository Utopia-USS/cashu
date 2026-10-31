// Cached views a budget write makes stale (F7 FIX2 B1 / B2; src/swr.ts): the app's fetch cache, so they stay
// with the transport (the pure budget helpers live in @cashu/ui-logic/budget/logic). Tested in
// tests/invalidation.test.mjs.
import { ck, invalidate } from "../../swr.ts";

/** The month close is cached under the card's keys (`budget/monthclose-card/<month>`) and the Przegląd widgets'
 * keys (`budget/monthclose/<month>`: the budget widget and the surplus card). Also stale after a strategy write
 * (its `investing` part is the contribution plan). */
export function monthCloseStale(slug: string): void {
  invalidate(ck(slug, "budget", "monthclose"));
  invalidate(ck(slug, "budget", "monthclose-card"));
}
/** A cushion save: the cushion top-up and the transfer of every month close, and the budget views around them. */
export function cushionSaved(slug: string): void {
  invalidate(ck(slug, "budget"));
}
/** A transaction's category change: the budget views and the cash pool (it counts "Wypłata gotówki"). */
export function recategorized(slug: string): void {
  invalidate(ck(slug, "budget"));
  invalidate(ck(slug, "cash"));
}
