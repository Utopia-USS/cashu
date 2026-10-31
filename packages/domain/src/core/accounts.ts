/** Account rules of `core/accounts.py` that do not touch storage. */

import { ibanKey } from "../iban.js";

/**
 * `own_ibans`: canonical keys of every account number the profile owns. A transaction whose
 * counterparty is one of these is a move within the profile's money, not income / expense. Per
 * profile: the caller passes one profile's accounts, so a transfer to a partner's account in another
 * profile stays a real outflow.
 */
export function ownIbans(accounts: Iterable<{ readonly iban: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const a of accounts) if (a.iban) out.add(ibanKey(a.iban));
  return out;
}
