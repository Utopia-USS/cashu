/**
 * Does a text look like a private person's name? The pure part of Python `core/mcp/names.py`
 * (`fold`, `normalize`, `person_part`, `looks_like_person` and their word lists), shared by the budget
 * import (an unknown CSV column's label) and the MCP privacy layer. The word lists are matching data,
 * byte-identical to Python (checked by `personNames.test.ts`, `budget-person.jsonl`).
 */

import { PY_END, uRegex } from "../pyRegex.js";
import { isCombining, PY_WS, pyIsDigit, pySplit, pyStrip, pyUpper } from "../text.js";

const words = (text: string): ReadonlySet<string> => new Set(text.trim().split(/\s+/));

/** Words that mark an organisation, not a person (upper case, no diacritics, no dots). */
export const BUSINESS_MARKERS: ReadonlySet<string> = words(`
  SP OO ZOO SA SK SKA SPJ SPOLKA SPOLDZIELNIA SPOLDZIELCZY SKLEP SKLEPY SHOP STORE STORES
  MARKET SUPERMARKET HIPERMARKET MARKETS BANK BANKU URZAD SKARBOWY SKARBOWA US ZUS KRUS GMINA
  GMINY MIASTO MIASTA POWIAT WOJEWODZTWO WSPOLNOTA WSPOLNOTY MIESZKANIOWA MIESZKANIOWY
  MIESZKANIOWE FUNDACJA STOWARZYSZENIE PHU PPHU FHU PPH PHP FPHU ZAKLAD ZAKLADY USLUGI
  USLUGOWY USLUGOWE SERWIS SERVICE SERVICES STACJA APTEKA APTEKI RESTAURACJA BAR CAFE
  KAWIARNIA PIEKARNIA HOTEL KLUB CENTRUM SZKOLA PRZEDSZKOLE UCZELNIA UNIWERSYTET KANCELARIA
  BIURO GROUP GRUPA HOLDING LTD LLC INC GMBH AG CO CORP COMPANY POLSKA POLAND ENERGIA ENERGA
  TAURON PGE ENEA ORANGE PLAY PLUS TMOBILE NETIA UPC VECTRA INSURANCE UBEZPIECZENIA
  UBEZPIECZEN TU TUIR PZU LEASING FINANCE FINANSE CREDIT KREDYT KREDYTU POZYCZKA TOWARZYSTWO
  INWESTYCYJNE TFI DOM MAKLERSKI BROKER ADMINISTRACJA ZARZAD NIERUCHOMOSCI OPERATOR GAZOWNIA
  WODOCIAGI WODOCIAGOW CIEPLOWNICTWO PARAFIA KOSCIOL ALLEGRO PAYU PAYPAL REVOLUT WISE STRIPE
  PRZELEWY24 DOTPAY BLIK TPAY POCZTA POLSKA PKP PKO MBANK ING SANTANDER PEKAO ERSTE MILLENNIUM
  ALIOR CITI NEST VELO PROFIT FIRMA HANDEL HANDLOWE HANDLOWA PRODUKCJA TRANSPORT AUTO MOTO
  GARAGE WARSZTAT SALON STUDIO GABINET KLINIKA SZPITAL PRZYCHODNIA MEDICAL MEDICOVER LUXMED
  ENEL FORTUM VEOLIA OPLATA OPLATY RATA PODATEK CZYNSZ
`);

/**
 * Markers that are also plausible surnames or first names: they only count with another marker or in
 * names of 3+ words ("JAN BAR" is a person, "BAR MLECZNY POD ORLEM" is not).
 */
export const AMBIGUOUS_MARKERS: ReadonlySet<string> = words(`
  DOM BAR PLUS AUTO MOTO SALON STUDIO PLAY NEST VELO PROFIT CO US TU AG SK SA ING CITI WISE
  SERWIS FIRMA HANDEL BIURO KLUB HOTEL ORANGE
`);

/** Where an address starts after a name ("ANNA NOWAK UL. POLNA 5 WARSZAWA"). */
export const ADDRESS_WORDS: ReadonlySet<string> = words(
  "UL ULICA AL ALEJA ALEJE OS OSIEDLE PL PLAC KOD ADRES",
);

/** @package Letters NFKD cannot strip (Python `_FOLD_EXTRA`). */
export const FOLD_EXTRA: Readonly<Record<string, string>> = {
  Ł: "L",
  ł: "L",
  Đ: "D",
  đ: "D",
  Ø: "O",
  ø: "O",
  ß: "SS",
  Æ: "AE",
  æ: "AE",
};

function foldChar(ch: string): string {
  const extra = FOLD_EXTRA[ch];
  if (extra !== undefined) return extra;
  let kept = "";
  for (const c of ch.normalize("NFKD")) if (!isCombining(c.codePointAt(0) as number)) kept += c;
  return pyUpper(kept);
}

/** `names.fold`: upper case without diacritics (`"Łoś"` -> `"LOS"`). */
export function foldName(text: string): string {
  let out = "";
  for (const ch of text) out += foldChar(ch);
  return out;
}

const SPACES = uRegex(`[${PY_WS}]+`, "g");

/** `names.normalize`: folded, dots and commas removed, whitespace collapsed. */
export function normalizeMerchantName(text: string | null | undefined): string {
  return pyStrip(
    foldName(text ?? "")
      .replace(/[.,]/g, "")
      .replace(SPACES, " "),
  );
}

const TOKEN = uRegex(`^[A-Z][A-Z'\\-]*${PY_END}`);

function tokens(text: string | null | undefined): string[] {
  return pySplit(normalizeMerchantName(text).replaceAll("-", " - ")).filter((t) => t !== "-");
}

const hasDigit = (t: string) => Array.from(t).some((c) => pyIsDigit(c.codePointAt(0) as number));

/** `person_part`: the leading words before an address or a number ("ANNA NOWAK UL POLNA 5" -> ANNA NOWAK). */
export function personPart(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of tokens(text)) {
    if (ADDRESS_WORDS.has(t) || hasDigit(t)) break;
    out.push(t);
  }
  return out;
}

/**
 * `looks_like_person`: 2-4 words of letters (initials allowed) before any address, none of them a
 * business marker (an ambiguous marker counts only next to another marker or in a longer name).
 */
export function looksLikePerson(text: string | null | undefined): boolean {
  const parts = personPart(text);
  if (parts.length < 2 || parts.length > 4) return false;
  if (parts.some((t) => !TOKEN.test(t))) return false;
  if (!parts.some((t) => Array.from(t).length >= 2)) return false;
  if (parts.some((t) => BUSINESS_MARKERS.has(t) && !AMBIGUOUS_MARKERS.has(t))) return false;
  const weak = parts.filter((t) => AMBIGUOUS_MARKERS.has(t));
  return !(weak.length > 0 && (weak.length >= 2 || parts.length >= 3));
}
