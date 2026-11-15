// Which merchants the budget screens offer a category rule for ("all from <merchant>"): only a key that
// names a merchant (`budget.isMerchantRuleKey`), exactly as the phone hides its toggle. A bank's generic
// phrase ("ZAKUP PRZY UZYCIU KARTY", "PRZELEW") stands for many merchants at once; the store refuses a rule
// on it (`generic_merchant`), so the offer is never shown and the refusal never reaches the owner.
import { budget } from "@cashu/domain";

export interface MerchantRuleOffer {
  merchantKey: string;
  /** What the offer names: the counterparty, else the row's merchant text, else the key. */
  name: string;
}

/** The rule offered after a manual category on one drill row, or null when none is offered. */
export function merchantRuleOffer(
  row: { merchantKey: string | null; counterparty: string | null; merchant: string },
  category: string,
): MerchantRuleOffer | null {
  if (category === "cash_withdrawal") return null;
  const merchantKey = row.merchantKey;
  if (!merchantKey || !budget.isMerchantRuleKey(merchantKey)) return null;
  return { merchantKey, name: row.counterparty || row.merchant || merchantKey };
}

/** The uncategorized merchant groups a rule may be saved for (order kept). */
export function ruleMerchants<T extends { merchantKey: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => budget.isMerchantRuleKey(r.merchantKey));
}
