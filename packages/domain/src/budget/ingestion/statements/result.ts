/** Outcome of parsing a bank statement: the statement, or a value-free reason the file is refused. */

import type { ParsedStatement } from "../types.js";

export type BankId = "mbank" | "erste" | "pekao";

export type StatementFailure =
  | { readonly ok: false; readonly reason: "undecodable" }
  | { readonly ok: false; readonly reason: "no_header" }
  /** `row` = the 1-based CSV record that holds the amount Python's `Decimal()` refused. */
  | { readonly ok: false; readonly reason: "bad_amount"; readonly row: number }
  /** `line` = the csv reader's `line_num` at the error. */
  | { readonly ok: false; readonly reason: "bad_csv"; readonly line: number }
  | { readonly ok: false; readonly reason: "unknown_bank" }
  | { readonly ok: false; readonly reason: "not_detected" };

export type StatementResult =
  | { readonly ok: true; readonly statement: ParsedStatement }
  | StatementFailure;

/** Unwinds a parser from deep inside its row loop; never leaves this folder (`refusing` catches it). */
class FileRefused extends Error {
  readonly failure: StatementFailure;

  constructor(failure: StatementFailure) {
    super(`statement refused: ${failure.reason}`);
    this.failure = failure;
  }
}

export function refuse(failure: StatementFailure): never {
  throw new FileRefused(failure);
}

/** Runs a parser body; a `refuse()` inside becomes its failure. */
export function refusing(parse: () => ParsedStatement): StatementResult {
  try {
    return { ok: true, statement: parse() };
  } catch (error) {
    if (error instanceof FileRefused) return error.failure;
    throw error;
  }
}
