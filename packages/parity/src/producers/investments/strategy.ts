/**
 * A profile's strategy for the parity producers, computed in TS: the files read from the dataset copy
 * (`service/strategy.read_files`), the newest stored version, and `@cashu/domain`'s loader and state
 * (`strategyStatus`). `strategyInputs` gives the values the portfolio pipeline, performance and the
 * budget month close take from it (formerly the strategy bridge).
 */

import type { Decimal, investments as inv } from "@cashu/domain";
import { DEFAULT_DATA_QUALITY } from "@cashu/domain/investments/rules";
import {
  MAX_STRATEGY_CHARS,
  type StrategyFiles,
  type StrategyStateName,
  type StrategyStatus,
  strategyStatus,
  usableConfig,
} from "@cashu/domain/investments/strategy";
import type { ProfileRow, PythonDb } from "../../sources/index.ts";

const MODULE = "investments";

/** What `service/portfolio.build`, `performance/service.load` and the month close read from it. */
export interface StrategyInputs {
  /** `StrategyState.state`. */
  readonly state: StrategyStateName;
  /** `config.benchmark` (`id`, `proxy`), null without a usable strategy or benchmark section. */
  readonly benchmark: { readonly id: string; readonly proxy: string } | null;
  /** `DataQualityPolicy.max_price_age_days` (the strategy's or the default). */
  readonly maxPriceAgeDays: number;
  readonly maxFxAgeDays: number;
  /** `config.contributions` (the valid or partial config), null without one. */
  readonly contributions: {
    readonly monthlyAmount: Decimal;
    readonly dayOfMonth: number | null;
  } | null;
  /** null without a usable strategy (`strategy is None`). */
  readonly strategy: {
    readonly baseCurrency: inv.Currency;
    readonly allocation: inv.AllocationPlan;
  } | null;
}

/** Strategy inputs of every profile with the investments module, by the profile's natural key. */
export type StrategyInputsByProfile = ReadonlyMap<string, StrategyInputs>;

/**
 * `read_text(encoding="utf-8")`: strict UTF-8 (a BOM is kept as U+FEFF) with universal newlines;
 * null where Python raises `UnicodeDecodeError`.
 */
function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

/**
 * `service/strategy.read_files`: (yaml, md, error) of the profile's strategy files. Python's decode
 * error names the byte and position; a file that is not UTF-8 gets a shorter text here.
 */
function readFiles(db: PythonDb, slug: string): StrategyFiles {
  const files = db.files();
  const read = (name: string): string | null => {
    const bytes = files.read(`profiles/${slug}/${name}`);
    if (bytes === undefined) return null;
    if (bytes.length > MAX_STRATEGY_CHARS * 4) throw new ReadError(`${name} is too large`);
    const text = decodeText(bytes);
    if (text === null) throw new ReadError("'utf-8' codec can't decode the file");
    return text;
  };
  try {
    return { yaml: read("strategy.yaml"), md: read("strategy.md"), readError: null };
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    return { yaml: null, md: null, readError: `cannot read the strategy files: ${error.message}` };
  }
}

class ReadError extends Error {}

/** `service/strategy.load(session, profile)` (no recording). */
export function profileStrategy(db: PythonDb, profile: ProfileRow): StrategyStatus {
  return strategyStatus(
    readFiles(db, profile.slug),
    db.investments.latestStrategyVersion(profile.id),
  );
}

/** The inputs the producers take from a strategy state (what the bridge used to export). */
function inputsOf(status: StrategyStatus): StrategyInputs {
  const config = usableConfig(status);
  const data = config?.data ?? DEFAULT_DATA_QUALITY;
  return {
    state: status.state,
    benchmark:
      config?.benchmark == null ? null : { id: config.benchmark.id, proxy: config.benchmark.proxy },
    maxPriceAgeDays: data.maxPriceAgeDays,
    maxFxAgeDays: data.maxFxAgeDays,
    contributions:
      config?.contributions == null
        ? null
        : {
            monthlyAmount: config.contributions.monthlyAmount,
            dayOfMonth: config.contributions.dayOfMonth,
          },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
}

/** `strategyInputs` of every profile with the investments module. */
export function strategyInputs(db: PythonDb): StrategyInputsByProfile {
  const out = new Map<string, StrategyInputs>();
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes(MODULE)) continue;
    out.set(db.keys.key("profiles", p.id), inputsOf(profileStrategy(db, p)));
  }
  return out;
}
