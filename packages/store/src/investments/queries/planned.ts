// Planned deposits (Python `service/planned.py`, read side): the vault's plans by status, one plan,
// the status filter of the list, and the brokerage deposits the booking match and the month plan read.
// `booked_txn_id` holds the view id of the transaction gid as the booking named it; a non-anchor
// member resolves to its row through `inv_transaction_members` (D-S2).
import { D, type Decimal, pyStrip } from "@cashu/domain";
import { gidOf, marks, type Read } from "./shared.js";
import { BROKERAGE } from "./transactions.js";

/** Python `PLANNED_DEPOSIT_STATUSES`. */
export const PLANNED_DEPOSIT_STATUSES = ["planned", "booked", "cancelled"] as const;
export type PlannedStatus = (typeof PLANNED_DEPOSIT_STATUSES)[number];
/** Python `DEFAULT_STATUSES`: what the list shows without a filter. */
const DEFAULT_PLANNED_STATUSES: readonly PlannedStatus[] = ["planned", "booked"];

export interface PlannedDepositView {
  readonly gid: string;
  /** The brokerage account the plan names, null for "any of the vault's brokerage accounts". */
  readonly account: string | null;
  readonly amount: Decimal;
  readonly currency: string;
  readonly plannedDate: string;
  readonly note: string | null;
  readonly status: PlannedStatus;
  /** The booking transaction's view gid (its row's anchor), null unless booked. */
  readonly bookedTxn: string | null;
  readonly bookedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const BOOKED_TXN = `COALESCE(
  (SELECT t.gid FROM inv_transaction_members m JOIN inv_transactions t ON t.id = m.transaction_id
   WHERE m.id = p.booked_txn_id),
  ${gidOf("p.booked_txn_id")})`;

const PLANNED_SQL = `SELECT p.gid, ${gidOf("p.account_id")} AS account, p.amount, p.currency,
  p.planned_date AS plannedDate, p.note, p.status, ${BOOKED_TXN} AS bookedTxn, p.booked_at AS bookedAt,
  p.created_at AS createdAt, p.updated_at AS updatedAt FROM inv_planned_deposits p`;

type PlannedRow = Omit<PlannedDepositView, "amount" | "status"> & {
  amount: string;
  status: string;
};

const isStatus = (s: string): s is PlannedStatus =>
  (PLANNED_DEPOSIT_STATUSES as readonly string[]).includes(s);

function toView(r: PlannedRow): PlannedDepositView {
  if (!isStatus(r.status)) throw new RangeError("unknown planned deposit status in the view");
  return { ...r, amount: D(r.amount), status: r.status };
}

/** Python `planned_deposits`: the vault's plans with these statuses, newest planned date first. */
export function plannedDeposits(
  read: Read,
  statuses: readonly PlannedStatus[] = DEFAULT_PLANNED_STATUSES,
): PlannedDepositView[] {
  const wanted = [...new Set(statuses)];
  if (wanted.length === 0) return [];
  return read<PlannedRow>(
    `${PLANNED_SQL} WHERE p.status IN (${marks(wanted.length)})
     ORDER BY p.planned_date DESC, p.id DESC`,
    ...wanted,
  ).map(toView);
}

/** Python `planned_deposit`: one plan of this vault (undefined for another vault's or none). */
export function plannedDeposit(read: Read, gid: string): PlannedDepositView | undefined {
  const r = read<PlannedRow>(`${PLANNED_SQL} WHERE p.gid = ?`, gid)[0];
  return r === undefined ? undefined : toView(r);
}

/** The open plans in booking order: oldest planned date first, fold order on ties. */
export function openPlannedDeposits(read: Read): PlannedDepositView[] {
  return read<PlannedRow>(
    `${PLANNED_SQL} WHERE p.status = 'planned' ORDER BY p.planned_date, p.id`,
  ).map(toView);
}

export type PlannedStatusesResult =
  | { readonly ok: true; readonly statuses: readonly PlannedStatus[] }
  | { readonly ok: false; readonly reason: "unknown_status" };

/** Python `parse_statuses`: `planned,booked` (default for blank), `all` or a comma list. */
export function parsePlannedStatuses(text: string | null | undefined): PlannedStatusesResult {
  if (text == null || pyStrip(text) === "") return { ok: true, statuses: DEFAULT_PLANNED_STATUSES };
  if (pyStrip(text) === "all") return { ok: true, statuses: PLANNED_DEPOSIT_STATUSES };
  const wanted = [
    ...new Set(
      text
        .split(",")
        .map((v) => pyStrip(v))
        .filter((v) => v !== ""),
    ),
  ];
  const statuses: PlannedStatus[] = [];
  for (const v of wanted) {
    if (!isStatus(v)) return { ok: false, reason: "unknown_status" };
    statuses.push(v);
  }
  return { ok: true, statuses };
}

/** A deposit transaction of one of the vault's brokerage accounts. */
export interface BrokerageDeposit {
  /** The row's view gid (its anchor). */
  readonly gid: string;
  readonly account: string;
  readonly tradeDate: string;
  readonly cashAmount: Decimal;
  readonly cashCurrency: string;
}

/**
 * The vault's brokerage deposits dated `since` (inclusive) up to `until` (inclusive, open when
 * omitted), in fold order (Python's row id order).
 */
export function brokerageDeposits(read: Read, since: string, until?: string): BrokerageDeposit[] {
  return read<{
    gid: string;
    account: string;
    tradeDate: string;
    cashAmount: string;
    cashCurrency: string;
  }>(
    `SELECT t.gid, a.gid AS account, t.trade_date AS tradeDate, t.cash_amount AS cashAmount,
       t.cash_currency AS cashCurrency
     FROM inv_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = ? AND t.type = 'deposit' AND t.trade_date >= ?
       ${until === undefined ? "" : "AND t.trade_date <= ?"}
     ORDER BY t.id`,
    BROKERAGE,
    since,
    ...(until === undefined ? [] : [until]),
  ).map((r) => ({ ...r, cashAmount: D(r.cashAmount) }));
}
