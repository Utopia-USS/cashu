/**
 * Research layer, pure part (`investments/research`): signal keys, scoring, near-duplicate
 * similarity, market segments, strategy text sections, research signal candidates and the
 * validation of notes, runs and topic market views. The services (runs, notes, views, segment
 * attribution, topic theses) need the store and come with S21b.
 */

export * from "./contract.js";
export * from "./instant.js";
export * from "./keys.js";
export { datetimeFromIsoformat, parseMoment } from "./moment.js";
export {
  ADVICE_CORE_PATTERN,
  ADVICE_PATTERN,
  ATTRIBUTION_PATTERN,
  adviceProblem,
  attributedTrendForecast,
  claimProblem,
  FORECAST_PATTERN,
  forecastProblem,
  hasQuantitativeEstimate,
  INSTITUTION_PATTERN,
  MARKET_ADVICE_PATTERN,
  marketViewProblem,
  NOT_INSTITUTIONAL_PATTERN,
  PERIOD_PATTERN,
  PRICE_CALL_PATTERN,
  SENTENCE_PATTERN,
  SPAN_PATTERN,
  YEAR_PATTERN,
} from "./patterns.js";
export * from "./scoring.js";
export * from "./segments.js";
export * from "./signals.js";
export * as similarity from "./similarity.js";
export * from "./strategyText.js";
export * from "./themes.js";
export { BYPASS_HOSTS, CONTROL_PATTERN, checkUrl, URL_MAX } from "./url.js";
export * from "./validation.js";
