/** Checks every importer's rows must pass before a commit (`plan.semantic_issues` of the Python code). */

import { ZERO } from "../../decimal.js";
import { TxnType } from "../domain/index.js";
import {
  blockingWarning,
  type ImportWarning,
  ImportWarningKind,
  type ParsedTxn,
} from "./contract.js";

/** Types that must reference an instrument. */
export const NEEDS_INSTRUMENT: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.SPLIT,
  TxnType.ADJUSTMENT,
]);

/** Types that must carry a quantity. */
export const NEEDS_QUANTITY: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);

/** Checks shared by every importer (blocking: a commit would store broken history). */
export function semanticIssues(txn: ParsedTxn, hasInstrument: boolean): ImportWarning[] {
  const name: string = txn.type;
  const issues: ImportWarning[] = [];
  if (NEEDS_INSTRUMENT.has(txn.type) && !hasInstrument) {
    issues.push(
      blockingWarning(
        txn.rowIndex,
        `${name} without an instrument`,
        ImportWarningKind.MISSING_INSTRUMENT,
      ),
    );
  }
  if (NEEDS_QUANTITY.has(txn.type) && txn.quantity === null) {
    issues.push(
      blockingWarning(
        txn.rowIndex,
        `${name} without a quantity`,
        ImportWarningKind.MISSING_QUANTITY,
      ),
    );
  }
  if (txn.type === TxnType.SPLIT && (txn.splitRatio === null || txn.splitRatio.lte(ZERO))) {
    issues.push(
      blockingWarning(
        txn.rowIndex,
        "split without a positive split ratio",
        ImportWarningKind.UNKNOWN_SPLIT_RATIO,
      ),
    );
  }
  if (txn.quantity?.lt(ZERO) || txn.grossAmount.lt(ZERO)) {
    issues.push(
      blockingWarning(
        txn.rowIndex,
        "negative quantity or gross amount",
        ImportWarningKind.NEGATIVE_AMOUNT,
      ),
    );
  }
  return issues;
}
