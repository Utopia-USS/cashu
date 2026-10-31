/**
 * Tries alias-based price sources per instrument in order, with fallback and attribution
 * (`market/composite.py`).
 */

import { AliasNamespace, aliasOf, type Instrument } from "../domain/instrument.js";
import type { CalendarDate } from "../domain/values.js";
import {
  NoPriceSourceException,
  type PriceHistory,
  type PriceSource,
  priceHistory,
  QuoteCurrencyMismatchException,
  reprError,
  SourceBlockedException,
  SourceException,
} from "./sources.js";

/** Source ids (= alias namespaces) to try for an instrument, most preferred first. */
export type PriceSourceOrder = (instrument: Instrument) => readonly string[];

/** `stooq` first for Warsaw listings (MIC `XWAR`), `yahoo` first for everything else. */
export function defaultPriceSourceOrder(instrument: Instrument): readonly string[] {
  if ((instrument.mic ?? "").toUpperCase() === "XWAR") {
    return [AliasNamespace.STOOQ, AliasNamespace.YAHOO];
  }
  return [AliasNamespace.YAHOO, AliasNamespace.STOOQ];
}

/** Per-source counters of one `CompositePriceSource` (one run). */
export interface SourceHealth {
  readonly sourceId: string;
  attempts: number;
  withData: number;
  empty: number;
  failures: number;
  /** Set after a `SourceBlockedException`; the source is skipped from then on. */
  blocked: boolean;
  lastError: string | null;
}

/** `SourceHealth.to_json`. */
export function sourceHealthJson(health: SourceHealth): Record<string, unknown> {
  return {
    attempts: health.attempts,
    with_data: health.withData,
    empty: health.empty,
    failures: health.failures,
    blocked: health.blocked,
    last_error: health.lastError,
  };
}

/** Optional log of the composite's decisions (the leader wires its local log). */
export interface MarketLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

const SILENT: MarketLog = { debug() {}, info() {}, warn() {} };

/** A price source that can tell which of its sources were blocked earlier in the run. */
export interface BlockAwareSource extends PriceSource {
  blocked(): ReadonlySet<string>;
}

/**
 * Returns the first non-empty answer of the sources the instrument has an alias for, in `order`. Every
 * bar keeps the `source` of the source that delivered it (attribution).
 *
 * Outcome:
 * - some source returned bars: that answer (with its splits and currency);
 * - no bars, but at least one source answered empty: an empty answer ("no data in range"), unless a
 *   source reported a quote currency mismatch (a configuration error worth reporting, R3);
 * - every candidate failed: one `SourceException` naming each failure (retryable if any was);
 * - no source can price the instrument: `NoPriceSourceException`.
 *
 * A source that throws `SourceBlockedException` is skipped for the rest of this instance's life, so
 * create one composite per run. `health` keeps per-source counters for the report.
 */
export class CompositePriceSource implements BlockAwareSource {
  readonly id = "composite";
  private readonly sources: Map<string, PriceSource>;
  private readonly order: PriceSourceOrder;
  private readonly log: MarketLog;
  private readonly healthBySource = new Map<string, SourceHealth>();

  constructor(
    sources: readonly PriceSource[],
    options: { readonly order?: PriceSourceOrder; readonly log?: MarketLog } = {},
  ) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
    this.order = options.order ?? defaultPriceSourceOrder;
    this.log = options.log ?? SILENT;
  }

  /** Counters per source id, for sources that were called or blocked in this run. */
  get health(): ReadonlyMap<string, SourceHealth> {
    return new Map(this.healthBySource);
  }

  /** Source ids blocked earlier in this run. */
  blocked(): ReadonlySet<string> {
    return new Set(
      [...this.healthBySource.values()].filter((h) => h.blocked).map((h) => h.sourceId),
    );
  }

  async fetch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<PriceHistory> {
    const preferred = [...this.order(instrument)];
    const ordered = [
      ...preferred,
      ...[...this.sources.keys()].filter((s) => !preferred.includes(s)),
    ];
    const candidates = ordered
      .filter((id) => this.sources.has(id) && aliasOf(instrument, id) !== null)
      .map((id) => this.sources.get(id) as PriceSource);
    if (candidates.length === 0) {
      throw new NoPriceSourceException(
        this.id,
        `no price source for this instrument (no ${[...this.sources.keys()].join(" / ")} alias)`,
      );
    }

    const failures: SourceException[] = [];
    let answeredEmpty = false;
    for (const source of candidates) {
      let health = this.healthBySource.get(source.id);
      if (health === undefined) {
        health = {
          sourceId: source.id,
          attempts: 0,
          withData: 0,
          empty: 0,
          failures: 0,
          blocked: false,
          lastError: null,
        };
        this.healthBySource.set(source.id, health);
      }
      if (health.blocked) {
        failures.push(
          new SourceException(
            source.id,
            `skipped, blocked earlier in this run (${health.lastError})`,
            {
              retryable: true,
            },
          ),
        );
        continue;
      }
      health.attempts += 1;
      let answer: PriceHistory;
      try {
        answer = await source.fetch(instrument, start, end);
      } catch (error) {
        health.failures += 1;
        if (error instanceof SourceException) {
          health.lastError = error.detail;
          if (error instanceof SourceBlockedException) health.blocked = true;
          failures.push(error);
          this.log.info(`${source.id} failed for ${instrument.id}: ${error.detail}`);
        } else {
          // a parser bug must not hide the other sources
          health.lastError = reprError(error);
          failures.push(new SourceException(source.id, reprError(error), { cause: error }));
          this.log.warn(`${source.id} failed unexpectedly for ${instrument.id}`);
        }
        continue;
      }
      if (answer.bars.length > 0) {
        health.withData += 1;
        return answer;
      }
      health.empty += 1;
      answeredEmpty = true;
      this.log.debug(`${source.id}: no bars for ${instrument.id} ${start}..${end}`);
    }

    const mismatch = failures.some((f) => f instanceof QuoteCurrencyMismatchException);
    if (answeredEmpty && !mismatch) return priceHistory();
    throw new SourceException(
      this.id,
      failures.map((f) => `${f.sourceId}: ${f.detail}`).join("; "),
      { retryable: failures.some((f) => f.retryable), cause: failures[0] },
    );
  }
}

/** True when `source` reports blocked sources (the composite, or a stand-in in tests). */
export function isBlockAware(source: PriceSource): source is BlockAwareSource {
  return typeof (source as Partial<BlockAwareSource>).blocked === "function";
}
