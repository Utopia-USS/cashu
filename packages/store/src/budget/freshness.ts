// How fresh the bank data of one vault is (`@cashu/store/budget/freshness`): the newest finished
// import batch (when and from which source) and the newest booking date. Its own entry so the phone,
// whose bundler (Metro) does not tree-shake, reads it without the budget barrel (statement import,
// desktop queries). It reads budget tables, so it lives in budget: core never depends on a module.
import { budget, type IsoDate } from "@cashu/domain";
import { BALANCE_SOURCES } from "../events/v1/core.js";
import { defineQuery } from "../query.js";
import { eventTimestamp } from "../sql/values.js";

export type BankSource = (typeof BALANCE_SOURCES)[number];

export interface DataFreshness {
  /** When the newest finished import batch ended (`YYYY-MM-DDTHH:MM:SS.mmmZ`); null without one. */
  readonly bankDataAt: string | null;
  /** That batch's source; null without a batch. */
  readonly bankSource: BankSource | null;
  /** The newest booking date on a visible bank account (cash pools are not bank data). */
  readonly newestBooking: IsoDate | null;
}

const isBankSource = (s: string): s is BankSource =>
  (BALANCE_SOURCES as readonly string[]).includes(s);

export const dataFreshness = defineQuery({
  id: "budget.dataFreshness",
  run(read): DataFreshness {
    const batch = read<{ finished_at: string; source: string }>(
      `SELECT finished_at, source FROM import_batches WHERE finished_at IS NOT NULL
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    )[0];
    const newest = read<{ day: IsoDate | null }>(
      `SELECT MAX(t.booking_date) AS day FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.removed_at IS NULL AND a.type <> ?`,
      budget.CASH_ACCOUNT_TYPE,
    )[0];
    return {
      bankDataAt: batch === undefined ? null : eventTimestamp(batch.finished_at),
      bankSource: batch !== undefined && isBankSource(batch.source) ? batch.source : null,
      newestBooking: newest?.day ?? null,
    };
  },
});
