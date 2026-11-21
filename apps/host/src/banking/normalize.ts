import { Decimal } from "@cashu/domain";
import {
  CREDIT_ACCOUNT_LABEL_TERMS,
  type RawJson,
  type RawTransaction,
  SAVINGS_ACCOUNT_LABEL_TERMS,
} from "@cashu/domain/budget";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function date(value: unknown): string | null {
  const text = string(value)?.slice(0, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))
    return null;
  return new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text ? text : null;
}
function decimal(value: unknown): Decimal | null {
  // EB money is a JSON string. A JSON number has already lost its original decimal token.
  if (typeof value !== "string") return null;
  try {
    return Decimal.parse(String(value));
  } catch {
    return null;
  }
}

/** Port of Python eb_transaction_to_raw; opaque bank ids never become the display title. */
export function transactionToRaw(value: Record<string, unknown>): RawTransaction | null {
  const amountObject = record(value.transaction_amount);
  let amount = decimal(amountObject.amount ?? "0");
  if (amount === null) return null;
  const indicator = string(value.credit_debit_indicator)?.toUpperCase() ?? "";
  if (indicator === "DBIT") amount = amount.abs().neg();
  else if (indicator === "CRDT") amount = amount.abs();
  const bookingDate = date(value.booking_date || value.value_date || value.transaction_date);
  if (!bookingDate) return null;
  const cp = record(indicator === "DBIT" ? value.creditor : value.debtor);
  const cpAccount = record(indicator === "DBIT" ? value.creditor_account : value.debtor_account);
  const remittance = value.remittance_information;
  const description =
    (Array.isArray(remittance)
      ? string(remittance.map(String).join(" "))?.trim()
      : string(remittance)?.trim()) ??
    string(value.note)?.trim() ??
    null;
  const entry = value.entry_reference || value.transaction_id;
  return {
    bookingDate,
    valueDate: date(value.value_date),
    amount,
    currency: string(amountObject.currency) ?? "PLN",
    counterpartyName: string(cp.name),
    counterpartyIban: string(cpAccount.iban),
    description,
    reference: description,
    bankTransactionId: entry ? String(entry) : null,
    source: "open_banking",
    raw: value as { readonly [k: string]: RawJson },
  };
}

const PRIORITY = new Map([
  ["CLBD", 0],
  ["ITAV", 1],
  ["XPCD", 2],
  ["PRCD", 3],
  ["OTHR", 4],
]);
export function pickBalance(
  values: readonly Record<string, unknown>[],
  today: string,
  currency: string,
): { date: string; amount: Decimal } | null {
  let chosen: { date: string; amount: Decimal; priority: number } | null = null;
  for (const value of values) {
    const money = record(value.balance_amount);
    if (string(money.currency) !== currency) continue;
    const amount = decimal(money.amount);
    if (amount === null) continue;
    const kind = string(value.balance_type)?.toUpperCase() ?? "OTHR";
    const priority = PRIORITY.get(kind) ?? 9;
    const item = {
      date: date(value.reference_date || value.reference_time) ?? today,
      amount,
      priority,
    };
    if (chosen === null || item.priority < chosen.priority) chosen = item;
  }
  return chosen && { date: chosen.date, amount: chosen.amount };
}

export function accountType(details: Record<string, unknown>): "checking" | "credit" | "savings" {
  const kind = string(details.cash_account_type)?.toUpperCase();
  const label = `${string(details.product) ?? ""} ${string(details.name) ?? ""}`.toLowerCase();
  if (kind === "CARD" || CREDIT_ACCOUNT_LABEL_TERMS.some((term) => label.includes(term)))
    return "credit";
  if (kind === "SVGS" || SAVINGS_ACCOUNT_LABEL_TERMS.some((term) => label.includes(term)))
    return "savings";
  return "checking";
}

export function accountDetails(value: Record<string, unknown>) {
  return {
    iban: string(record(value.account_id).iban) ?? string(value.iban),
    name: string(value.name) ?? string(value.product),
    currency: string(value.currency),
  };
}
