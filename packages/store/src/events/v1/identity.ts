// Account identity key rules (spec: events.md 6.4, gid.md 4.3; review N2).
//
// An `iban:` identity key may merge accounts for good, so it is accepted only for a number that
// passes the ISO 13616 mod-97 check: a parser bug (a masked, short or mistyped number) can then never
// fuse two accounts. `normalizeIbanLoose` / `ibanKeyLoose` mirror core/text.py (`normalize_iban`,
// `iban_key`); the canonical ports are S05's `normalizeIban` / `ibanKey` in packages/domain, which
// writers use. They are repeated here only so the store package stays dependency-free.

/** core/text.py normalize_iban: alphanumerics only, upper case. */
export function normalizeIbanLoose(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** core/text.py iban_key: normalized, a leading 2-letter country code dropped. */
export function ibanKeyLoose(value: string | null | undefined): string {
  const s = normalizeIbanLoose(value);
  return s.length > 2 && /^[A-Z]{2}/.test(s) ? s.slice(2) : s;
}

/**
 * True when `value` is a valid IBAN by mod-97, or a bare 26-digit Polish NRB (the CSV form), which is
 * checked as `PL` + NRB.
 */
export function isValidIban(value: string | null | undefined): boolean {
  let s = normalizeIbanLoose(value);
  if (/^[0-9]{26}$/.test(s)) s = `PL${s}`;
  if (!/^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/**
 * Whether an event may claim `key` (events.md 6.4): `ext:` keys always; an `iban:` key only when the
 * same event carries an `iban` that passes `isValidIban` and whose iban key equals the claimed key.
 */
export function claimAllowed(key: string, eventIban: unknown): boolean {
  if (!key.startsWith("iban:")) return true;
  return (
    typeof eventIban === "string" &&
    isValidIban(eventIban) &&
    `iban:${ibanKeyLoose(eventIban)}` === key
  );
}
