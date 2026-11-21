/**
 * The phrase checks of research validation (`research/validation.py`): the Python pattern sources
 * (matching data, Polish and English; the English forecast words of `FORECAST_PATTERN` were added
 * here), compiled with Python `re` semantics by `pyRegex`. Every check is a warning to the agent,
 * never a refusal.
 */

import { pyRegex } from "../../pyRegex.js";
import { PY_WS } from "../../text.js";

/**
 * Words a brief or headline should not use (P9, a warning): a forecast (`wzrośnie`, `spadnie`,
 * `będzie`, `podrożeje`, `will rise`, `will be`, `going to fall`, ...), a call (`kupuj`, `sprzedaj`)
 * or a price target (`cel cenowy`). The English alternatives mirror the Polish ones for an agent
 * writing in English (the app language); bare `buy` / `sell` stay allowed (`sell-off` is a fact).
 */
export const FORECAST_PATTERN =
  String.raw`(?i)\b(?:wzro[sś]n(?:ie|[aą])|ur[oó][sś]n(?:ie|[aą])|spadn(?:ie|[aą])|b[eę]dzie|b[eę]d[aą]` +
  "|podro[zż]eje|podro[zż]ej[aą]|stanieje|staniej[aą]|potanieje|potaniej[aą]|odbij(?:e|[aą])" +
  String.raw`|prognoz\w*|kupuj(?:cie)?|sprzedaj(?:cie)?|cel\w*\s+cenow\w*|cen\w*\s+docelow\w*` +
  String.raw`|(?:will|won't|going\s+to)\s+(?:not\s+)?(?:rise|grow|fall|drop|increase|decrease|rebound` +
  String.raw`|recover|climb|surge|soar|plunge|double|be)|forecast\w*|predict\w*)(?!\w)`;

/** Recommendations, analyst ratings and price targets (the part `_ADVICE` and `_MARKET_ADVICE` share). */
export const ADVICE_CORE_PATTERN =
  "(?i)" +
  String.raw`\b(?:cen\w*|kurs\w*)\s+docelow\w*` +
  String.raw`|\b(?:price|share)[\s-]+targets?\b|\btarget\s+price\b` +
  String.raw`|\brekomendacj\w*\s+(?:kupuj|kupno|sprzedaj|sprzeda[zż]|trzymaj|akumuluj|redukuj|neutraln\w*` +
  String.raw`|przewa[zż]\w*|niedowa[zż]\w*)` +
  String.raw`|\b(?:strong\s+)?(?:buy|sell|hold|overweight|underweight|outperform|underperform)\s+rating\b` +
  String.raw`|\b(?:upgrade[sd]?|downgrade[sd]?)\s+to\s+(?:buy|sell|hold|overweight|underweight|outperform` +
  String.raw`|underperform)\b` +
  String.raw`|\b(?:kupuj|sprzedawaj|kup\s+teraz|sprzedaj\s+teraz|warto\s+(?:kupi[cć]|sprzeda[cć])` +
  String.raw`|nale[zż]y\s+(?:kupi[cć]|sprzeda[cć])|buy\s+now|sell\s+now)\b` +
  String.raw`|\b(?:you\s+should|we\s+recommend|i\s+recommend)\s+(?:buy|sell)\w*`;

/** `_ADVICE_CORE` plus "rises to a number" price predictions: a note never carries one. */
export const ADVICE_PATTERN =
  ADVICE_CORE_PATTERN +
  String.raw`|\b(?:wzro[sś]nie|urośnie|urosnie|spadnie|podro[zż]eje|potanieje|dojdzie)\s+do\s+\d` +
  String.raw`|\bwill\s+(?:rise|fall|reach|hit|drop|climb|trade)\s+(?:(?:to|at)\s+)?\d`;

/** `_ADVICE` for a topic market view (P11): a market / demand estimate may name a level, a price with a number may not. */
export const MARKET_ADVICE_PATTERN =
  ADVICE_CORE_PATTERN +
  String.raw`|\bcen(?:a|y|ie|ę|ą|om|ami|ach)?(?!\w)(?:\s+\S+){0,3}?\s+(?:wzro[sś]n\w*|ur[oó][sś]n\w*|spadn\w*|podro[zż]\w*` +
  String.raw`|potanie\w*|dojd\w*|osi[aą]gn\w*)\s+(?:do|o)\s+\d` +
  String.raw`|\bprices?\s+(?:will|should|could)\s+(?:rise|fall|reach|hit|drop|climb|trade)\b`;

/** Price-call wording a topic market view never uses (P11): price targets, a price / quote / index move, an imperative buy / sell. */
export const PRICE_CALL_PATTERN =
  "(?i)" +
  String.raw`\bcel\w*\s+cenow\w*|\bcen\w*\s+docelow\w*|\bwycen\w*\s+docelow\w*` +
  String.raw`|\b(?:kurs\w*|notowa\w*|akcj\w*|walor\w*|wycen\w*|indeks\w*|index\w*|S&P(?:\s*500)?` +
  String.raw`|WIG\w*|DAX|Nasdaq\w*|Dow\s+Jones|Nikkei\w*|MSCI(?:\s+\S+)?|Stoxx\w*|FTSE\w*|giełd\w*` +
  String.raw`|rynek\s+akcji|rynk\w*\s+akcji)(?:\s+\S+){0,3}?\s+` +
  String.raw`(?:wzro[sś]n\w*|ur[oó][sś]n\w*|spadn\w*|podwoi\w*|potroi\w*|podro[zż]\w*|potanie\w*` +
  String.raw`|staniej\w*|odbij\w*|dojd\w*|osi[aą]gn\w*|przebij\w*|zyska\w*|straci\w*)` +
  String.raw`|\b(?:price|stock|shares?|index|indices|S&P(?:\s*500)?|Nasdaq|Dow|equities|valuations?)\s+` +
  String.raw`(?:will|should|could)\s+(?:rise|fall|reach|hit|drop|climb|double)` +
  String.raw`|\b(?:upside|downside)\s+(?:of|to)\s+\d` +
  String.raw`|\b(?:kup|kupuj|dokup|dokupuj|sprzedaj|sprzedawaj|zredukuj)\b` +
  String.raw`|\bzrealizuj\w*\s+zysk`;

/** Sentence boundary: after `.!?;`, before an upper-case (Polish) letter. */
export const SENTENCE_PATTERN = String.raw`(?<=[.!?;])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ])`;

/** Institutions whose published forecasts of macro and market trends may be cited (owner decision 2026-10-10). Case-sensitive (acronyms). */
export const INSTITUTION_PATTERN =
  String.raw`\b(?:MFW|IMF|OECD|Bank\w*\s+Światow\w*|World\s+Bank|Fed\w*|FOMC|Rezerw\w*\s+Federaln\w*` +
  String.raw`|EBC|ECB|NBP|RPP|BoE|BoJ|Bank\w*\s+(?:Anglii|Japonii|Kanady|of\s+England|of\s+Japan)` +
  String.raw`|IEA|MAE|EIA|OPEC\w*|IFR|SIA|WSTS|Gartner\w*|IDC|BNEF|Eurostat\w*|GUS|KE|CBO` +
  String.raw`|Komisj\w*\s+Europejsk\w*|European\s+Commission` +
  String.raw`|Międzynarodow\w*\s+(?:Fundusz\w*\s+Walutow\w*|Agencj\w*\s+Energetyczn\w*` +
  String.raw`|Federacj\w*\s+Robotyki))(?!\w)`;

/** Attribution words of a cited forecast (`prognozuje`, `szacuje`, `według`, `dot plot`). */
export const ATTRIBUTION_PATTERN =
  String.raw`(?i)\b(?:prognoz\w*|projekcj\w*|szacu\w*|szacun\w*|przewidu\w*|oczekuj\w*|zakład\w*` +
  String.raw`|według|wg|dot\s+plot\w*|kropk\w*|forecast\w*|project\w*|estimat\w*|expects?)(?!\w)`;

/** The writer's own or an analyst's forecast (`prognozujemy`, `analitycy`, `konsensus`): never an institution's. */
export const NOT_INSTITUTIONAL_PATTERN =
  String.raw`(?i)\b(?:prognozuj(?:emy|ę)|przewiduj(?:emy|ę)|spodziewa(?:my|m)\s+si[eę]|oczekuj(?:emy|ę)` +
  String.raw`|szacuj(?:emy|ę)|uwa[zż]a(?:my|m)|s[aą]dz(?:imy|ę)|naszym\s+zdaniem|moim\s+zdaniem` +
  String.raw`|we\s+(?:expect|forecast|predict)|i\s+(?:expect|forecast|predict)|analityk\w*|analyst\w*` +
  String.raw`|konsensus\w*|consensus|dom\w*\s+maklersk\w*|broker\w*|rekomendacj\w*|rating\w*)(?!\w)`;

/** A year (`2030`), not part of a larger number. */
export const YEAR_PATTERN = String.raw`(?<![\d.,])(?:19|20)\d{2}(?![\d.,%])`;

/** A horizon (`2-4 lat`, `12 mies.`). */
export const SPAN_PATTERN =
  String.raw`(?i)(?<![\d.,])\d+(?:\s*[-\u2013]\s*\d+)?\s*(?:lat\w*|rok\w*|mies\w*|kwarta\w*|tygod\w*` +
  String.raw`|dni|years?|months?|quarters?|weeks?|days?)\b`;

/** A quarter or half (`Q3`, `H1`). */
export const PERIOD_PATTERN = String.raw`(?i)\b[QH][1-4]\b`;

const FORECAST = pyRegex(FORECAST_PATTERN);
const ADVICE = pyRegex(ADVICE_PATTERN);
const MARKET_ADVICE = pyRegex(MARKET_ADVICE_PATTERN);
const PRICE_CALL = pyRegex(PRICE_CALL_PATTERN);
const SENTENCE = pyRegex(SENTENCE_PATTERN, "g");
const INSTITUTION = pyRegex(INSTITUTION_PATTERN);
const ATTRIBUTION = pyRegex(ATTRIBUTION_PATTERN);
const NOT_INSTITUTIONAL = pyRegex(NOT_INSTITUTIONAL_PATTERN);
const YEAR = pyRegex(YEAR_PATTERN, "g");
const SPAN = pyRegex(SPAN_PATTERN, "g");
const PERIOD = pyRegex(PERIOD_PATTERN, "g");
const ANY_DIGIT = pyRegex(String.raw`\d`);

const ALL_SPACE = new RegExp(`^[${PY_WS}]*$`, "u");

/** Python `[s for s in _SENTENCE.split(text) if s.strip()]`. */
function sentences(text: string): string[] {
  return text.split(SENTENCE).filter((s) => !ALL_SPACE.test(s));
}

/** True when `text` reads like a recommendation, an analyst rating or a price prediction. */
export function adviceProblem(text: string | null | undefined): boolean {
  return !!text && ADVICE.test(text);
}

/** True when a topic market view reads like advice or a security price call (P11). */
export function marketViewProblem(text: string | null | undefined): boolean {
  return !!text && (MARKET_ADVICE.test(text) || PRICE_CALL.test(text));
}

/**
 * True when `sentence` cites an institution's forecast of a macro or market trend (owner decision
 * 2026-10-10: `MFW prognozuje wzrost PKB USA o 2,1 % w 2027`): it names an institution and an
 * attribution word, is not the writer's own or an analyst's forecast, and is not a call, a price
 * target or a price / valuation / index forecast of a security (`marketViewProblem`).
 */
export function attributedTrendForecast(sentence: string | null | undefined): boolean {
  return (
    !!sentence &&
    INSTITUTION.test(sentence) &&
    ATTRIBUTION.test(sentence) &&
    !NOT_INSTITUTIONAL.test(sentence) &&
    !marketViewProblem(sentence)
  );
}

/**
 * True when a sentence of `text` uses a word a brief never uses and is not an institution's cited
 * trend forecast.
 */
export function forecastProblem(text: string | null | undefined): boolean {
  return !!text && sentences(text).some((s) => FORECAST.test(s) && !attributedTrendForecast(s));
}

/**
 * True when a sentence of a note or brief text reads like advice, a rating or a price prediction and
 * is not an institution's cited trend forecast (`MFW: inflacja spadnie do 2,4 % w 2027` passes,
 * `kurs wzrośnie do 50 zł` does not).
 */
export function claimProblem(text: string | null | undefined): boolean {
  return !!text && sentences(text).some((s) => adviceProblem(s) && !attributedTrendForecast(s));
}

/**
 * True when `text` names at least one number other than a year (`2030`), a horizon (`2-4 lat`) or a
 * quarter (`Q3`): the size or growth of a market or demand (`575 tys. instalacji`, `+4% rocznie`).
 */
export function hasQuantitativeEstimate(text: string | null | undefined): boolean {
  if (!text) return false;
  const rest = text.replace(YEAR, " ").replace(SPAN, " ").replace(PERIOD, " ");
  return ANY_DIGIT.test(rest);
}
