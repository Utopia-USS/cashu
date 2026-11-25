/** Account-number normalisation identical to Python's `core/text.py` (`normalize_iban`, `iban_key`). */

/**
 * `normalize_iban`: only ASCII letters and digits kept, upper-cased (bank exports guard account numbers
 * with a leading `'` for Excel, group them with spaces, and so on). Empty for null / "".
 */
export function normalizeIban(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * `iban_key`: canonical account key for matching across sources. Polish CSV exports give the bare
 * 26-digit NRB while Open Banking returns the IBAN with its country prefix, so a leading two-letter
 * country code is dropped (only when something follows it).
 */
export function ibanKey(value: string | null | undefined): string {
  const s = normalizeIban(value);
  if (s.length > 2 && /^[A-Z]{2}/.test(s)) return s.slice(2);
  return s;
}
