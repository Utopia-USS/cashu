/**
 * Parses and validates strategy.yaml into a `StrategyConfig` (`strategy/loader.py`), reporting every
 * problem with its YAML path, line and column. Pure: the caller reads the files.
 *
 * Validation: `version` (supported: 1) and `base_currency` are required; `allocation.targets` must
 * reference defined buckets and sum to 1 (+-0.001); rule ids are unique, kinds come from the catalog
 * and each kind validates its params (`custom` compiles its expression); unknown keys anywhere are
 * warnings with a closest-known-key hint. YAML syntax errors, duplicate keys, anchors / aliases, merge
 * keys and custom tags are errors with the parser's location.
 */

import { formatFloat } from "../../decimal.js";
import { isPyNumber, pyStr } from "../../pyYaml/plain.js";
import { pyStrip } from "../../text.js";
import {
  allocationPlan,
  type BucketDef,
  bucketDef,
  bucketMatchIsEmpty,
} from "../domain/buckets.js";
import { AssetClass } from "../domain/enums.js";
import type { Currency } from "../domain/values.js";
import { RuleCatalog } from "../rules/catalog.js";
import { didYouMean } from "../rules/hints.js";
import { DEFAULT_DATA_QUALITY } from "../rules/kind.js";
import {
  DEFAULT_REBALANCE,
  type RebalancePolicy,
  readRebalancePolicy,
} from "../rules/kinds/allocationDrift.js";
import { ParamErrors, ParamReader, parseCurrency } from "../rules/params.js";
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REVIEW,
  type StrategyConfig,
  WATCHLIST_KNOWN_KEYS,
  type WatchlistCriteria,
} from "./config.js";
import { isError, type StrategyLoadResult, strategyIssue } from "./issues.js";
import { Reporter } from "./reporter.js";
import { inactiveRules, RULE_PATH, readRules } from "./rulesSection.js";
import {
  ID_PATTERN,
  ID_RULE,
  readBenchmark,
  readContributions,
  readData,
  readMatch,
  readNotifications,
  readReview,
} from "./sections.js";
import * as tree from "./yamlTree.js";

/** Top-level keys of strategy.yaml, in documentation order. */
export const TOP_LEVEL_KEYS = [
  "version",
  "base_currency",
  "horizon_years",
  "contributions",
  "data",
  "buckets",
  "allocation",
  "rules",
  "watchlist",
  "benchmark",
  "notifications",
  "review",
] as const;

export const SUPPORTED_VERSIONS: readonly bigint[] = [1n];
/** Allowed deviation of the `allocation.targets` sum from 1. */
export const TARGET_SUM_TOLERANCE = 0.001;

interface Header {
  readonly version: number;
  readonly baseCurrency: Currency;
  readonly horizonYears: number | null;
}

interface BucketEntry {
  readonly definition: BucketDef;
  readonly node: tree.MappingNode;
  readonly index: number;
}

interface Allocation {
  readonly targets: Map<string, number>;
  readonly rebalance: RebalancePolicy;
  readonly rebalanceNode: tree.MappingNode | null;
}

/**
 * `load_strategy` / `StrategyLoader(catalog).load`: parses `yamlText`; `md` (strategy.md) is kept on the
 * config and only checked for being non-empty.
 */
export function loadStrategy(
  yamlText: string,
  md: string | null = null,
  catalog: RuleCatalog = RuleCatalog.builtIn(),
): StrategyLoadResult {
  return new Parse(catalog, yamlText, md).run();
}

/** One-shot parse state (`_Parse`). */
class Parse {
  private readonly out: Reporter;
  private readonly catalog: RuleCatalog;
  private readonly source: string;
  private readonly md: string | null;

  constructor(catalog: RuleCatalog, source: string, md: string | null) {
    this.catalog = catalog;
    this.source = source;
    this.md = md;
    this.out = new Reporter(source);
  }

  run(): StrategyLoadResult {
    const out = this.out;
    const composed = tree.compose(this.source);
    if (!composed.ok) {
      const { message, line, column } = composed.error;
      out.push(strategyIssue("error", "", message, line, column));
      return result(null, out, null, []);
    }
    const root = composed.root;
    if (root === null || root.kind !== "mapping") {
      if (tree.isAbsent(root)) {
        const message = "strategy.yaml is empty; it needs at least version and base_currency";
        out.push(strategyIssue("error", "", message, 1, 1));
      } else {
        out.error(
          "",
          root,
          "strategy.yaml must be a mapping of keys (version, base_currency, ...)",
        );
      }
      return result(null, out, null, []);
    }

    const header = this.header(root);
    const data = out.section(root, "data", readData) ?? DEFAULT_DATA_QUALITY;
    const contributions = out.section(root, "contributions", readContributions);
    const buckets = this.buckets(root);
    const allocation = this.allocation(root, buckets);
    const rules = readRules(out, this.catalog, root, {
      bucketIds: buckets.map((bucket) => bucket.definition.id),
      hasTargets: allocation.targets.size > 0,
      rebalance: allocation.rebalance,
      rebalanceNode: allocation.rebalanceNode,
      hasContributions: !tree.isAbsent(tree.get(root, "contributions")),
    });
    const watchlist = this.watchlist(root);
    const benchmark = out.section(root, "benchmark", (reader) =>
      readBenchmark(reader, header?.baseCurrency ?? null),
    );
    const notifications =
      out.section(root, "notifications", readNotifications) ?? DEFAULT_NOTIFICATIONS;
    const review = out.section(root, "review", readReview) ?? DEFAULT_REVIEW;
    if (this.md !== null && !pyStrip(this.md)) {
      out.push(
        strategyIssue(
          "warning",
          "strategy.md",
          "strategy.md is empty; write down your goals so later reports have context",
        ),
      );
    }

    const config = (h: Header): StrategyConfig =>
      Object.freeze({
        version: h.version,
        baseCurrency: h.baseCurrency,
        horizonYears: h.horizonYears,
        allocation: allocationPlan({
          buckets: buckets.map((bucket) => bucket.definition),
          targets: allocation.targets,
        }),
        rebalance: allocation.rebalance,
        data,
        contributions,
        rules,
        watchlist,
        benchmark,
        notifications,
        review,
        markdown: this.md,
      });

    const errors = out.issues.filter(isError);
    const inactive = inactiveRules(root, errors);
    if (header === null || errors.length > 0) {
      const onlyRules = header !== null && errors.every((e) => RULE_PATH.test(e.path));
      return result(null, out, onlyRules && header !== null ? config(header) : null, inactive);
    }
    return result(config(header), out, null, []);
  }

  // --- sections -------------------------------------------------------------------------------

  private header(root: tree.MappingNode): Header | null {
    const errors = new ParamErrors();
    const raw = tree.plainMap(root);
    const reader = new ParamReader(raw, errors);
    const version = reader.integer("version");
    const currencyCode = reader.optionalString("base_currency");
    const horizonYears = reader.optionalInteger("horizon_years", { minimum: 1, maximum: 100 });
    reader.finish(TOP_LEVEL_KEYS);

    const rawVersion = raw.get("version");
    if (typeof rawVersion === "bigint" && !SUPPORTED_VERSIONS.includes(rawVersion)) {
      const supported = SUPPORTED_VERSIONS.join(", ");
      errors.error("version", `Unsupported version ${rawVersion} (supported: ${supported})`);
    }
    let baseCurrency: Currency | null = null;
    if (currencyCode === null) {
      if (!reader.has("base_currency")) {
        errors.error("base_currency", "base_currency is required (e.g. PLN)");
      }
    } else {
      baseCurrency = parseCurrency(currencyCode);
      if (baseCurrency === null) {
        errors.error("base_currency", `"${currencyCode}" is not a three-letter ISO currency code`);
      } else if (baseCurrency !== "PLN") {
        errors.warning(
          "base_currency",
          "Only PLN is fully supported as base currency (FX rates come from NBP in PLN)",
        );
      }
    }
    this.out.report(errors.issues, root, "");
    if (errors.hasErrors || baseCurrency === null) return null;
    return { version, baseCurrency, horizonYears };
  }

  private buckets(root: tree.MappingNode): BucketEntry[] {
    const out = this.out;
    const node = tree.get(root, "buckets");
    if (tree.isAbsent(node)) return [];
    if (node.kind !== "sequence") {
      out.error("buckets", node, "buckets must be a list of {id, match} entries");
      return [];
    }
    const found: BucketEntry[] = [];
    const firstLine = new Map<string, number>();
    for (const [index, item] of node.value.entries()) {
      const path = `buckets[${index}]`;
      if (item.kind !== "mapping") {
        out.error(path, item, "Each bucket must be a mapping with id and match");
        continue;
      }
      const errors = new ParamErrors();
      const reader = new ParamReader(tree.plainMap(item), errors);
      const bucketId = reader.optionalString("id");
      reader.has("match");
      reader.finish();
      if (bucketId === null) {
        if (!reader.has("id")) errors.error("id", "Bucket id is required");
      } else if (!ID_PATTERN.test(bucketId)) {
        errors.error("id", `Bucket id "${bucketId}" ${ID_RULE}`);
      } else if (firstLine.has(bucketId)) {
        errors.error(
          "id",
          `Duplicate bucket id "${bucketId}" (first defined on line ${firstLine.get(bucketId)})`,
        );
      } else {
        firstLine.set(bucketId, tree.position(item)[0]);
      }
      out.report(errors.issues, item, path);

      let match = null;
      if (tree.isAbsent(tree.get(item, "match"))) {
        out.error(
          `${path}.match`,
          item,
          "match is required (use match: {} for a catch-all bucket)",
        );
      } else {
        match = out.section(item, "match", readMatch, path);
      }
      if (!errors.hasErrors && bucketId !== null && match !== null) {
        found.push({ definition: bucketDef({ id: bucketId, match }), node: item, index });
      }
    }

    for (const entry of found.slice(0, -1)) {
      if (bucketMatchIsEmpty(entry.definition.match)) {
        out.warning(
          `buckets[${entry.index}].match`,
          entry.node,
          `Bucket "${entry.definition.id}" matches every instrument, so the buckets after it never match`,
        );
      }
    }
    const takesCash = found.some(
      (entry) =>
        bucketMatchIsEmpty(entry.definition.match) ||
        entry.definition.match.assetClasses.has(AssetClass.CASH),
    );
    if (found.length > 0 && !takesCash) {
      out.warning(
        "buckets",
        node,
        "No bucket matches asset_class: cash, so cash balances stay unallocated",
      );
    }
    return found;
  }

  private allocation(root: tree.MappingNode, buckets: readonly BucketEntry[]): Allocation {
    const out = this.out;
    const none = (rebalance: RebalancePolicy, rebalanceNode: tree.MappingNode | null) => ({
      targets: new Map<string, number>(),
      rebalance,
      rebalanceNode,
    });
    const node = tree.get(root, "allocation");
    if (tree.isAbsent(node)) {
      const bucketsNode = tree.get(root, "buckets");
      if (buckets.length > 0 && bucketsNode !== null) {
        out.warning(
          "buckets",
          bucketsNode,
          "Buckets are defined but allocation.targets is missing",
        );
      }
      return none(DEFAULT_REBALANCE, null);
    }
    if (node.kind !== "mapping") {
      out.error("allocation", node, "allocation must be a mapping with targets and rebalance");
      return none(DEFAULT_REBALANCE, null);
    }
    out.checkKeys(node, "allocation", ["targets", "rebalance"]);

    const rebalance =
      out.section(node, "rebalance", readRebalancePolicy, "allocation") ?? DEFAULT_REBALANCE;
    const rebalanceYaml = tree.get(node, "rebalance");
    const rebalanceNode = rebalanceYaml?.kind === "mapping" ? rebalanceYaml : null;

    const targetsNode = tree.get(node, "targets");
    if (tree.isAbsent(targetsNode)) {
      out.error(
        "allocation.targets",
        node,
        "allocation.targets is required (bucket id -> weight, summing to 1)",
      );
      return none(rebalance, rebalanceNode);
    }
    if (targetsNode.kind !== "mapping") {
      out.error(
        "allocation.targets",
        targetsNode,
        "allocation.targets must be a mapping of bucket id -> weight",
      );
      return none(rebalance, rebalanceNode);
    }

    const bucketIds = buckets.map((bucket) => bucket.definition.id);
    const targets = new Map<string, number>();
    let allValid = true;
    for (const entry of tree.entries(targetsNode)) {
      const bucketId = entry.key;
      const path = `allocation.targets.${bucketId}`;
      const value = tree.toPlain(entry.value);
      if (!bucketIds.includes(bucketId)) {
        allValid = false;
        const message =
          bucketIds.length > 0
            ? `Target references undefined bucket "${bucketId}"${didYouMean(bucketId, bucketIds)}`
            : `Target references undefined bucket "${bucketId}" (no buckets are defined)`;
        out.error(path, entry.keyNode, message);
        continue;
      }
      const inRange =
        typeof value === "bigint"
          ? value >= 0n && value <= 1n
          : isPyNumber(value) && value >= 0 && value <= 1;
      if (!inRange) {
        allValid = false;
        out.error(
          path,
          entry.value,
          `Target of ${bucketId} must be a number between 0 and 1 (0.6 = 60%), got ${pyStr(value)}`,
        );
        continue;
      }
      targets.set(bucketId, Number(value));
    }
    if (allValid) {
      let total = 0;
      for (const weight of targets.values()) total += weight;
      if (Math.abs(total - 1) > TARGET_SUM_TOLERANCE) {
        out.error(
          "allocation.targets",
          targetsNode,
          `Targets sum to ${formatFloat(total, ".3f")}, expected 1 (+-${TARGET_SUM_TOLERANCE})`,
        );
      }
    }
    for (const bucket of buckets) {
      if (targets.has(bucket.definition.id)) continue;
      out.warning(
        "allocation.targets",
        targetsNode,
        `Bucket "${bucket.definition.id}" has no target in allocation.targets; it is treated as 0`,
      );
      targets.set(bucket.definition.id, 0.0);
    }
    return { targets, rebalance, rebalanceNode };
  }

  private watchlist(root: tree.MappingNode): WatchlistCriteria {
    const out = this.out;
    const empty: WatchlistCriteria = { values: new Map() };
    const node = tree.get(root, "watchlist");
    if (tree.isAbsent(node)) return empty;
    if (node.kind !== "mapping") {
      out.error("watchlist", node, "watchlist must be a mapping with criteria");
      return empty;
    }
    out.checkKeys(node, "watchlist", ["criteria"]);
    const criteria = tree.get(node, "criteria");
    if (tree.isAbsent(criteria)) return empty;
    if (criteria.kind !== "mapping") {
      out.error(
        "watchlist.criteria",
        criteria,
        "watchlist.criteria must be a mapping of criterion -> number",
      );
      return empty;
    }
    const values = new Map<string, number>();
    for (const entry of tree.entries(criteria)) {
      const value = tree.toPlain(entry.value);
      const path = `watchlist.criteria.${entry.key}`;
      // math.isfinite(int) raises OverflowError past 1.8e308 in Python; here it is not finite
      if (!isPyNumber(value) || !Number.isFinite(Number(value))) {
        out.error(path, entry.value, `${entry.key} must be a number, got ${pyStr(value)}`);
        continue;
      }
      const known: readonly string[] = WATCHLIST_KNOWN_KEYS;
      if (!known.includes(entry.key)) {
        out.warning(
          path,
          entry.keyNode,
          `Unknown criterion "${entry.key}"${didYouMean(entry.key, known)}; it is kept for later stages`,
        );
      }
      values.set(entry.key, Number(value));
    }
    return { values };
  }
}

function result(
  config: StrategyConfig | null,
  out: Reporter,
  partial: StrategyConfig | null,
  inactive: StrategyLoadResult["inactiveRules"],
): StrategyLoadResult {
  return Object.freeze({ config, issues: [...out.issues], partial, inactiveRules: inactive });
}
