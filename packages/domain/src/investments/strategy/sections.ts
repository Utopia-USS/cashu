/**
 * The section readers of `strategy/loader.py` (`_read_data`, `_read_contributions`, `_read_match`,
 * `_read_benchmark`, `_read_notifications`, `_read_review`): one ParamReader each, reads in Python's
 * order (the order decides the known keys of the typo hints and the order of the issues).
 */

import { Decimal } from "../../decimal.js";
import { pyLen, pyLower, pyStrip, pyUpper } from "../../text.js";
import { type BucketMatch, bucketMatch } from "../domain/buckets.js";
import { SIGNAL_SEVERITIES, type SignalSeverity } from "../domain/enums.js";
import type { Currency } from "../domain/values.js";
import { asInstrumentId } from "../domain/values.js";
import { didYouMean } from "../rules/hints.js";
import {
  type ContributionPlan,
  type DataQualityPolicy,
  DEFAULT_DATA_QUALITY,
  MAX_UNVERIFIED_DAYS,
} from "../rules/kind.js";
import type { ParamReader } from "../rules/params.js";
import {
  type Benchmark,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REVIEW,
  type NotificationPolicy,
  REVIEW_CARDS,
  REVIEW_EVERY,
  type ReviewEvery,
  type ReviewPolicy,
  WEEKDAYS,
  type Weekday,
} from "./config.js";

/** `[A-Za-z0-9_.-]+` as Python's `re.match(...$)`, which also accepts one final newline. */
export const ID_PATTERN = /^[A-Za-z0-9_.-]+\n?$/;
export const ID_RULE = 'may only contain letters, digits, "_", "." and "-"';

const REVIEW_NAME_MAX = 40;

export function readData(reader: ParamReader): DataQualityPolicy {
  const defaults = DEFAULT_DATA_QUALITY;
  return {
    maxPriceAgeDays: reader.integer("max_price_age_days", {
      fallback: defaults.maxPriceAgeDays,
      minimum: 1,
    }),
    maxStaleWeight: reader.number("max_stale_weight", {
      fallback: defaults.maxStaleWeight,
      minimum: 0,
      maximum: 1,
    }),
    maxUnclassifiedWeight: reader.number("max_unclassified_weight", {
      fallback: defaults.maxUnclassifiedWeight,
      minimum: 0,
      maximum: 1,
    }),
    maxFxAgeDays: reader.integer("max_fx_age_days", {
      fallback: defaults.maxFxAgeDays,
      minimum: 1,
    }),
    maxUnverifiedDays: readUnverifiedDays(reader, defaults.maxUnverifiedDays),
  };
}

/** `max_unverified_days`: absent -> the default; an explicit null -> null (never expire). */
function readUnverifiedDays(reader: ParamReader, fallback: number | null): number | null {
  const key = "max_unverified_days";
  if (reader.raw.has(key) && reader.raw.get(key) === null) {
    reader.has(key); // known key
    return null;
  }
  return reader.integer(key, {
    ...(fallback === null ? {} : { fallback }),
    minimum: 1,
    maximum: MAX_UNVERIFIED_DAYS,
  });
}

export function readContributions(reader: ParamReader): ContributionPlan {
  return {
    monthlyAmount: reader.decimal("monthly_amount", {
      minimum: Decimal.fromInt(0),
      exclusiveMin: true,
    }),
    dayOfMonth: reader.optionalInteger("day_of_month", { minimum: 1, maximum: 31 }),
  };
}

export function readMatch(reader: ParamReader): BucketMatch {
  const assetClasses = reader.assetClasses("asset_class");
  const tags = reader.strings("tags");
  const mics = reader.strings("mic").map(pyUpper);
  const currencies = reader.currencies("currency");
  const instrumentIds = reader.strings("instrument_ids").map(asInstrumentId);
  return bucketMatch({ assetClasses, tags, mics, currencies, instrumentIds });
}

export function readBenchmark(reader: ParamReader, base: Currency | null): Benchmark | null {
  const benchmarkId = reader.optionalString("id");
  const proxy = reader.optionalString("proxy");
  const currencies = reader.currencies("currency");
  if (benchmarkId === null) {
    if (!reader.has("id")) reader.errors.error("id", "benchmark.id is required (e.g. msci_acwi)");
  } else if (!ID_PATTERN.test(benchmarkId)) {
    reader.errors.error("id", `Benchmark id "${benchmarkId}" ${ID_RULE}`);
  }
  if (proxy === null) {
    if (!reader.has("proxy")) {
      reader.errors.error(
        "proxy",
        "benchmark.proxy is required: a Yahoo symbol or ISIN of an instrument tracking it",
      );
    }
  } else if (!pyStrip(proxy)) {
    reader.errors.error("proxy", "benchmark.proxy must not be empty");
  }
  if (currencies.size > 1) {
    reader.errors.error("currency", "benchmark.currency must be one currency code");
  }
  const [first] = currencies;
  const currency = first ?? base ?? ("PLN" as Currency);
  if (benchmarkId === null || proxy === null) return null;
  return { id: benchmarkId, proxy: pyStrip(proxy), currency };
}

export function readNotifications(reader: ParamReader): NotificationPolicy {
  let immediate = DEFAULT_NOTIFICATIONS.immediate;
  if (reader.has("immediate")) {
    const names: readonly string[] = SIGNAL_SEVERITIES;
    const chosen = new Set<SignalSeverity>();
    for (const name of reader.strings("immediate")) {
      const lower = pyLower(name);
      if (names.includes(lower)) chosen.add(lower as SignalSeverity);
      else {
        reader.errors.error(
          "immediate",
          `Unknown severity "${name}"${didYouMean(name, names)}; allowed: ${names.join(", ")}`,
        );
      }
    }
    immediate = chosen;
  }
  let digestWeekday = DEFAULT_NOTIFICATIONS.digestWeekday;
  const day = reader.optionalString("digest_weekday");
  if (day !== null) {
    const chosen = weekdayOf(day);
    if (chosen !== null) digestWeekday = chosen;
    else {
      reader.errors.error(
        "digest_weekday",
        `Unknown weekday "${day}"${didYouMean(day, WEEKDAYS)}; allowed: ${WEEKDAYS.join(", ")}`,
      );
    }
  }
  return { immediate, digestWeekday };
}

function weekdayOf(text: string): Weekday | null {
  const key = pyLower(pyStrip(text));
  return WEEKDAYS.find((day) => day === key) ?? null;
}

export function readReview(reader: ParamReader): ReviewPolicy {
  let every: ReviewEvery = DEFAULT_REVIEW.every;
  const rawEvery = reader.optionalString("every");
  if (rawEvery !== null) {
    const key = pyLower(pyStrip(rawEvery));
    const found = REVIEW_EVERY.find((value) => value === key);
    if (found !== undefined) every = found;
    else {
      reader.errors.error(
        "every",
        `Unknown review frequency "${rawEvery}"${didYouMean(rawEvery, REVIEW_EVERY)}; allowed: ${REVIEW_EVERY.join(", ")}`,
      );
    }
  }
  let day: Weekday | null = null;
  const rawDay = reader.optionalString("day");
  if (rawDay !== null) {
    day = weekdayOf(rawDay);
    if (day === null) {
      reader.errors.error(
        "day",
        `Unknown weekday "${rawDay}"${didYouMean(rawDay, WEEKDAYS)}; allowed: ${WEEKDAYS.join(", ")}`,
      );
    }
  }
  let name = reader.optionalString("name");
  if (name !== null) {
    name = pyStrip(name) || null;
    if (name !== null && pyLen(name) > REVIEW_NAME_MAX) {
      reader.errors.error("name", `review.name is longer than ${REVIEW_NAME_MAX} characters`);
    }
  }
  let cards: readonly string[] = REVIEW_CARDS;
  if (reader.has("cards")) {
    const known: readonly string[] = REVIEW_CARDS;
    const chosen: string[] = [];
    for (const card of reader.strings("cards")) {
      const key = pyLower(pyStrip(card));
      if (!known.includes(key)) {
        reader.errors.error(
          "cards",
          `Unknown review card "${card}"${didYouMean(card, known)}; allowed: ${known.join(", ")}`,
        );
      } else {
        chosen.push(key);
      }
    }
    if (chosen.length === 0 && !reader.errors.hasErrors) {
      reader.errors.error("cards", "review.cards needs at least one card");
    }
    cards = chosen;
  }
  return { every, day, name, cards };
}
