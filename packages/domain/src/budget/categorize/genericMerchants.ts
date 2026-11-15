/**
 * Merchant keys that name a payment channel, not a merchant: a bank's operation type ("card
 * purchase", "BLIK payment", "outgoing transfer") that `merchantKey` falls back to when a row has no
 * counterparty and no title (an mBank row with an empty `#Tytuł` and `#Nadawca/Odbiorca`, a generic
 * CSV with only a description). Many different merchants and people hide behind one such key, so a
 * category rule on it ("same for every ... payment") would file all of them alike: no rule is ever
 * offered or written for one (`isMerchantRuleKey`).
 *
 * A closed list compared with the whole normalized key (`normalizeText`: upper case, no
 * diacritics), never a prefix: "ZAKUP PRZY UZYCIU KARTY SKLEP TEST" names a merchant and stays a
 * rule key. Kinds of operation that are one category whatever the row (cash withdrawals, card or
 * account fees) are deliberately not here: a rule on them files like rows alike.
 * Matching data (Polish bank wording): never translate.
 */

import { normalizeText } from "../../text.js";

export const GENERIC_MERCHANT_KEYS: readonly string[] = Object.freeze([
  // card payments
  "ZAKUP PRZY UZYCIU KARTY",
  "ZAKUP PRZY UZYCIU KARTY W INTERNECIE",
  "ZAKUP KARTA",
  "PLATNOSC KARTA",
  "TRANSAKCJA KARTA",
  "TRANSAKCJA KARTA PLATNICZA",
  "TRANSAKCJA KARTOWA",
  "OPERACJA KARTA",
  "OPERACJA KARTOWA",
  // BLIK
  "BLIK",
  "ZAKUP BLIK",
  "PLATNOSC BLIK",
  "TRANSAKCJA BLIK",
  "BLIK ZAKUP E-COMMERCE",
  "PRZELEW BLIK",
  "BLIK P2P",
  "PRZELEW NA TELEFON",
  "PRZELEW NA TELEFON BLIK",
  "PRZELEW NA TELEFON PRZYCHODZACY",
  "PRZELEW NA TELEFON WYCHODZACY",
  // transfers
  "PRZELEW",
  "PRZELEW WYCHODZACY",
  "PRZELEW PRZYCHODZACY",
  "PRZELEW WLASNY",
  "PRZELEW SRODKOW",
  "PRZELEW ZEWNETRZNY",
  "PRZELEW ZEWNETRZNY WYCHODZACY",
  "PRZELEW ZEWNETRZNY PRZYCHODZACY",
  "PRZELEW WEWNETRZNY",
  "PRZELEW WEWNETRZNY WYCHODZACY",
  "PRZELEW WEWNETRZNY PRZYCHODZACY",
  "PRZELEW ZAGRANICZNY",
  "PRZELEW SEPA",
  "PRZELEW NATYCHMIASTOWY",
  "PRZELEW EKSPRESOWY",
  "PRZELEW EXPRESS ELIXIR",
  "PRZELEW NA KONTO",
  "PRZELEW NA RACHUNEK",
  "PRZELEW Z RACHUNKU",
  "PRZEKAZ",
  "POLECENIE PRZELEWU",
  // a purchase, payment or credit with no one named
  "ZAKUP",
  "PLATNOSC",
  "PLATNOSC INTERNETOWA",
  "PLATNOSC MOBILNA",
  "TRANSAKCJA",
  "OBCIAZENIE",
  "UZNANIE",
  "WPLATA",
]);

const GENERIC: ReadonlySet<string> = new Set(GENERIC_MERCHANT_KEYS);

/**
 * Whether a category rule may be keyed on `key` (an owner's pin, "same for every ... payment"): it
 * names something (not empty) and is not a bank's generic operation phrase. The phone offers the
 * rule only for such a key and the store's `setMerchantCategory` refuses any other.
 */
export function isMerchantRuleKey(key: string | null | undefined): boolean {
  const k = normalizeText(key);
  return k !== "" && !GENERIC.has(k);
}
