import { InstitutionRegistry } from "../../../core/index.js";
import {
  looksLikeBudgetDocument,
  parseBudgetDocument,
  reportAsDict,
  reportSummary,
  validateBudgetDocument,
} from "../canonical/document.js";
import type { ParsedStatement, TxnSource } from "../types.js";

/** The generator's `canonical_out` shape, for the canonical vector and docs tests. */
const registry = new InstitutionRegistry();

function statementOut(stmt: ParsedStatement | null): unknown {
  if (stmt === null) return null;
  return {
    bank: stmt.bank,
    account_number: stmt.accountNumber,
    account_name: stmt.accountName,
    currency: stmt.currency,
    transactions: stmt.transactions.map((t) => ({
      booking_date: t.bookingDate,
      value_date: t.valueDate,
      amount: t.amount.toString(),
      currency: t.currency,
      counterparty_name: t.counterpartyName,
      counterparty_iban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      bank_transaction_id: t.bankTransactionId,
      source: t.source,
      raw: t.raw,
    })),
    balances: stmt.balances.map((b) => [b.date, b.amount.toString()]),
    closing_balances: stmt.closingBalances.map((b) => [b.date, b.amount.toString()]),
  };
}

/** The generator's `canonical_out` shape. */
export function canonicalOut(content: Uint8Array, name: string, source: TxnSource): unknown {
  const r = parseBudgetDocument(content, name, { registry, source });
  const report = source === "csv" ? validateBudgetDocument(content, name, registry) : null;
  return {
    issues: r.issues.map((i) => [i.kind, i.row, i.field, i.message, i.blocking]),
    ok: r.statement !== null && !r.issues.some((i) => i.blocking),
    variant: r.variant,
    source: r.source,
    institution: r.institution,
    transactions: r.transactionCount,
    balances: r.closingCount,
    statement: statementOut(r.statement),
    report: report === null ? null : reportAsDict(report),
    summary: report === null ? null : reportSummary(report),
    looks_like: looksLikeBudgetDocument(content, name),
  };
}
