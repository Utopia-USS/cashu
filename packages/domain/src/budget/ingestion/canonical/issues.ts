/** Value-free validation issues of a budget document (Python `canonical.BudgetIssue`). */

export type IssueKind =
  | "file_format"
  | "missing_column"
  | "unknown_field"
  | "missing_value"
  | "invalid_value"
  | "inconsistent_file"
  | "duplicate_id"
  | "currency_mismatch"
  | "unknown_institution"
  | "empty"
  | "overlap";

/**
 * `row`: the 1-based transaction (JSON array position + 1, CSV data row after the header), null for
 * document-level problems; `field`: the field name or path (`account.currency`, `balances[2].amount`).
 */
export interface BudgetIssue {
  readonly kind: IssueKind;
  readonly message: string;
  readonly row: number | null;
  readonly field: string | null;
  readonly blocking: boolean;
}

export function budgetIssue(
  kind: IssueKind,
  message: string,
  row: number | null = null,
  field: string | null = null,
  blocking = true,
): BudgetIssue {
  return { kind, message, row, field, blocking };
}

/** `BudgetIssue.code`: the catalog label `import.<kind>`. */
export function issueCode(issue: BudgetIssue): string {
  return `import.${issue.kind}`;
}

/** `str(issue)`: `row 3: amount: message (warning)`. */
export function formatIssue(issue: BudgetIssue): string {
  const where = issue.row === null ? "" : `row ${issue.row}: `;
  const name = issue.field === null ? "" : `${issue.field}: `;
  return `${where}${name}${issue.message}${issue.blocking ? "" : " (warning)"}`;
}

/** `BudgetIssue.as_dict()`. */
export function issueAsDict(issue: BudgetIssue): Record<string, string | number | boolean | null> {
  return {
    kind: issue.kind,
    code: issueCode(issue),
    row: issue.row,
    field: issue.field,
    message: issue.message,
    blocking: issue.blocking,
  };
}

/** `_dedupe`: the first of equal (kind, row, field, message). */
export function dedupeIssues(issues: readonly BudgetIssue[]): BudgetIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = JSON.stringify([i.kind, i.row, i.field, i.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
