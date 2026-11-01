/**
 * Which merchant strings may go to the cloud classifier (Anthropic). PRIVACY(D-09.5): the gate is
 * structural and fails closed. Python sends every unknown merchant key; `merchant_key` takes the
 * counterparty name first, so a transfer to a person sends that person's name (live-app fix list).
 * Here a merchant is eligible only if NONE of the vault's rows with that merchant key has a
 * counterparty account number or a person-to-person marker; `looksLikePerson` is a second filter on
 * top. The local (Ollama) path is unchanged: nothing leaves the machine there.
 */

import { looksLikePerson } from "../../core/index.js";
import type { Decimal } from "../../decimal.js";
import { type EngineTxn, txnMerchantKey, txnText } from "./engine.js";
import { unknownMerchants } from "./llmPass.js";

/** A merchant string the cloud gate let through; only `cloudMerchants` creates one. */
export type CloudMerchant = string & { readonly __cloudMerchant: unique symbol };

/**
 * PRIVACY(D-09.5): person-to-person markers, matched as whole words in the normalized transaction
 * text (reference, description, counterparty; upper case, no diacritics). A closed list: BLIK to a
 * phone number, P2P titles, transfers "for" / "from" someone, refunds to a person, P2P apps.
 * Matching data (Polish bank wording): never translate.
 */
export const P2P_MARKERS: readonly string[] = Object.freeze([
  "NA TELEFON",
  "NA NUMER TELEFONU",
  "NA NR TELEFONU",
  "NA NR TEL",
  "PRZELEW NA TEL",
  "TELEFON",
  "P2P",
  "BLIK P2P",
  "BLIK PRZELEW",
  "PRZELEW BLIK",
  "PRZELEW DLA",
  "PRZELEW OD",
  "PRZELEW WLASNY",
  "PRZELEW SRODKOW",
  "PRZELEW PRZYCHODZACY",
  "PRZELEW WYCHODZACY",
  "PRZELEW ZEWNETRZNY",
  "PRZELEW WEWNETRZNY",
  "PRZELEW NA KONTO",
  "PRZELEW NA RACHUNEK",
  "PRZEKAZ",
  "ZWROT DLA",
  "ZWROT OD",
  "DLA",
  "OD",
  "REVOLUT",
  "PAYPAL",
]);

const MARKER_RE = new RegExp(
  `(?<![A-Z0-9])(?:${[...P2P_MARKERS]
    .sort((a, b) => b.length - a.length)
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![A-Z0-9])`,
);

/** PRIVACY(D-09.5): true when the row's normalized text carries a person-to-person marker. */
export function hasP2pMarker(text: string): boolean {
  return MARKER_RE.test(text);
}

/**
 * PRIVACY(D-09.5): whether one merchant string may be sent on its own merits (the per-string
 * filters, applied again by the request builder): not person-like.
 */
export function isCloudSafeString(merchant: string): boolean {
  return !!merchant && !looksLikePerson(merchant);
}

export interface CloudRow extends EngineTxn {
  /** The row's effective category source (`default` = the engine could not decide). */
  readonly source: string | null;
}

/**
 * The unknown merchants (`unknownMerchants`) the cloud classifier may see, code point order.
 * PRIVACY(D-09.5): `rows` must be every row of the vault (not only the unknown ones): a merchant
 * key seen on any row with a counterparty IBAN or a P2P marker is never eligible.
 */
export function cloudMerchants(rows: readonly CloudRow[]): CloudMerchant[] {
  const tainted = new Set<string>();
  const unknownInput: { amount: Decimal; merchantKey: string; source: string | null }[] = [];
  for (const r of rows) {
    const mk = txnMerchantKey(r);
    if (r.counterpartyIban?.trim() || hasP2pMarker(txnText(r))) tainted.add(mk);
    unknownInput.push({ amount: r.amount, merchantKey: mk, source: r.source });
  }
  return unknownMerchants(unknownInput).filter(
    (m): m is CloudMerchant => !tainted.has(m) && isCloudSafeString(m),
  );
}
