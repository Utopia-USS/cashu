/** Collects what the record readers produce into one `ImportParseResult` (`_ResultBuilder`). */

import { pyLen } from "../../../text.js";
import {
  blockingWarning,
  type ImportParseResult,
  type ImportWarning,
  ImportWarningKind,
  importParseResult,
  importWarning,
  type ParsedCorporateAction,
  type ParsedPosition,
  type ParsedTxn,
} from "../contract.js";
import { MAX_ACCOUNT_HINT, MAX_SOURCE, SOURCE_RE } from "./constants.js";
import { RecordReader, type Value } from "./recordReader.js";

export class ResultBuilder {
  private readonly txns: ParsedTxn[] = [];
  private readonly positions: ParsedPosition[] = [];
  private readonly actions: ParsedCorporateAction[] = [];
  /** Blocking and non-blocking problems, in the order found. */
  readonly warnings: ImportWarning[] = [];
  private readonly fileValues = new Map<string, string>();

  error(row: number | null, message: string, kind: string = ImportWarningKind.INVALID_VALUE): void {
    this.warnings.push(blockingWarning(row, message, kind));
  }

  /** A file-level value (`source`, `account_hint`): checked, and equal in every row that has one. */
  fileValue(row: number | null, key: string, value: string | null): void {
    if (value === null) return;
    if (key === "source" && (pyLen(value) > MAX_SOURCE || !SOURCE_RE.test(value))) {
      this.error(row, `source: "${value}" must be lower-case letters, digits and "_" (max 32)`);
      return;
    }
    if (key === "account_hint" && pyLen(value) > MAX_ACCOUNT_HINT) {
      this.error(row, `account_hint: longer than ${MAX_ACCOUNT_HINT} characters`);
      return;
    }
    const known = this.fileValues.get(key);
    if (known === undefined) {
      this.fileValues.set(key, value);
    } else if (known !== value) {
      this.error(
        row,
        `${key}: "${value}" differs from "${known}" (one file = one account)`,
        ImportWarningKind.INCONSISTENT_FILE,
      );
    }
  }

  /** Read one record; its problems join the warnings, a clean one joins the result. */
  record(row: number, values: ReadonlyMap<string, Value>, raw: ReadonlyMap<string, string>): void {
    const reader = new RecordReader(row, values);
    const parsed = reader.read(raw);
    this.warnings.push(...reader.issues);
    if (parsed === null) return;
    if (parsed.record === "txn") this.txns.push(parsed.txn);
    else if (parsed.record === "position") this.positions.push(parsed.position);
    else this.actions.push(parsed.action);
  }

  result(): ImportParseResult {
    const dates = [...new Set(this.positions.map((position) => position.asOf))];
    if (dates.length > 1) {
      this.warnings.push(
        importWarning({
          kind: ImportWarningKind.POSITION_SNAPSHOT,
          message: `Position records have ${dates.length} different dates (${[...dates].sort().join(", ")}); a snapshot should share one date`,
        }),
      );
    }
    const counts = new Map<string, { asOf: string; label: string; count: number }>();
    for (const position of this.positions) {
      const label = position.isin || position.symbol || position.name || "";
      const key = JSON.stringify([position.asOf, label]);
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { asOf: position.asOf, label, count: 1 });
      else entry.count += 1;
    }
    for (const { asOf, label, count } of counts.values()) {
      if (count > 1) {
        this.warnings.push(
          importWarning({
            kind: ImportWarningKind.POSITION_SNAPSHOT,
            message: `${count} position records for ${label} on ${asOf}; they are added up`,
          }),
        );
      }
    }
    return importParseResult({
      txns: this.txns,
      positions: this.positions,
      corporateActions: this.actions,
      warnings: this.warnings,
      accountHint: this.fileValues.get("account_hint") ?? null,
      source: this.fileValues.get("source") ?? null,
    });
  }
}
