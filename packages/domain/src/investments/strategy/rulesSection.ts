/**
 * The `rules:` section of strategy.yaml (`_rules`, `_cross_check`, `_check_bucket_list` and
 * `_inactive_rules` of `strategy/loader.py`): each entry's id, kind, severity, cooldown and polarity,
 * its params parsed by the kind from the catalog, and the cross-checks against buckets, targets and
 * the contributions plan.
 */

import type { PyPlainMap } from "../../pyYaml/plain.js";
import { SIGNAL_SEVERITIES, SignalSeverity } from "../domain/enums.js";
import type { RuleCatalog } from "../rules/catalog.js";
import { bucketReferences, Scope } from "../rules/expr/index.js";
import { didYouMean } from "../rules/hints.js";
import type { RuleSpec } from "../rules/kind.js";
import {
  ALLOCATION_DRIFT,
  type AllocationDriftParams,
  type RebalancePolicy,
  rebalanceToRaw,
} from "../rules/kinds/allocationDrift.js";
import { CONTRIBUTION_GAP } from "../rules/kinds/contributionGap.js";
import { CUSTOM, type CustomParams } from "../rules/kinds/custom.js";
import { ParamErrors, ParamReader } from "../rules/params.js";
import { SIGNAL_POLARITIES, SignalPolarity } from "../rules/polarity.js";
import type { InactiveRule, StrategyIssue } from "./issues.js";
import type { Reporter } from "./reporter.js";
import { ID_PATTERN, ID_RULE } from "./sections.js";
import * as tree from "./yamlTree.js";

/** `rules[<index>]` at the start of an issue path. */
export const RULE_PATH = /^rules\[(\d+)\]/;

export interface RulesContext {
  readonly bucketIds: readonly string[];
  readonly hasTargets: boolean;
  readonly rebalance: RebalancePolicy;
  readonly rebalanceNode: tree.MappingNode | null;
  readonly hasContributions: boolean;
}

/** `_rules`: the valid rule specs in declaration order; every problem goes to `out`. */
export function readRules(
  out: Reporter,
  catalog: RuleCatalog,
  root: tree.MappingNode,
  ctx: RulesContext,
): RuleSpec[] {
  const node = tree.get(root, "rules");
  const specs: RuleSpec[] = [];
  let hasDriftRule = false;
  if (!tree.isAbsent(node) && node.kind !== "sequence") {
    out.error("rules", node, "rules must be a list of {id, kind, params} entries");
  } else if (node?.kind === "sequence") {
    const firstLine = new Map<string, number>();
    const knownKinds = catalog.kinds;
    for (const [index, item] of node.value.entries()) {
      const path = `rules[${index}]`;
      if (item.kind !== "mapping") {
        out.error(path, item, "Each rule must be a mapping with id, kind and optional params");
        continue;
      }
      const errorCount = out.errorCount;
      const errors = new ParamErrors();
      const reader = new ParamReader(tree.plainMap(item), errors);
      const ruleId = reader.optionalString("id");
      const kindName = reader.optionalString("kind");
      const severity = reader.enumValue("severity", SIGNAL_SEVERITIES, SignalSeverity.INFO);
      const cooldownDays = reader.optionalInteger("cooldown_days", { minimum: 0 });
      // optional override of the kind's default polarity
      const polarity = reader.has("polarity")
        ? reader.enumValue("polarity", SIGNAL_POLARITIES, SignalPolarity.NEUTRAL)
        : null;
      reader.has("params");
      reader.finish();
      if (ruleId === null) {
        if (!reader.has("id")) errors.error("id", "Rule id is required");
      } else if (!ID_PATTERN.test(ruleId)) {
        errors.error("id", `Rule id "${ruleId}" ${ID_RULE}`);
      } else if (firstLine.has(ruleId)) {
        errors.error(
          "id",
          `Duplicate rule id "${ruleId}" (first defined on line ${firstLine.get(ruleId)})`,
        );
      } else {
        firstLine.set(ruleId, tree.position(item)[0]);
      }
      const kind = kindName === null ? null : catalog.get(kindName);
      if (kindName === null) {
        if (!reader.has("kind")) {
          errors.error("kind", `Rule kind is required; known: ${knownKinds.join(", ")}`);
        }
      } else if (kind === null) {
        errors.error(
          "kind",
          `Unknown rule kind "${kindName}"${didYouMean(kindName, knownKinds)}; known: ${knownKinds.join(", ")}`,
        );
      }
      out.report(errors.issues, item, path);

      const paramsNode = tree.get(item, "params");
      let raw: PyPlainMap = new Map();
      if (!tree.isAbsent(paramsNode)) {
        if (paramsNode.kind !== "mapping") {
          out.error(`${path}.params`, paramsNode, "params must be a mapping");
          continue;
        }
        raw = tree.plainMap(paramsNode);
      }
      if (kind === null) continue;
      if (kind.kind === ALLOCATION_DRIFT) {
        hasDriftRule = true;
        // `{**rebalance.to_raw(), **raw}`: a key the rule sets keeps the defaults' position
        const merged = rebalanceToRaw(ctx.rebalance);
        for (const [key, value] of raw) merged.set(key, value);
        raw = merged;
      }
      const paramErrors = new ParamErrors();
      const params = kind.parseParams(raw, paramErrors);
      const spec: RuleSpec = {
        id: ruleId ?? "",
        kind: kind.kind,
        params,
        severity,
        cooldownDays,
        polarity,
      };
      const base = paramsNode?.kind === "mapping" ? paramsNode : item;
      out.report(paramErrors.issues, base, `${path}.params`);
      if (!paramErrors.hasErrors) crossCheck(out, spec, item, path, ctx);
      if (out.errorCount === errorCount) specs.push(spec);
    }
  }
  if (ctx.rebalanceNode !== null && !hasDriftRule) {
    out.warning(
      "allocation.rebalance",
      ctx.rebalanceNode,
      "Rebalance bands are only checked by an allocation_drift rule; add one to rules",
    );
  }
  return specs;
}

function crossCheck(
  out: Reporter,
  spec: RuleSpec,
  node: tree.MappingNode,
  path: string,
  ctx: RulesContext,
): void {
  const paramsNode = tree.get(node, "params");
  const paramsMap = paramsNode?.kind === "mapping" ? paramsNode : null;
  if (spec.kind === ALLOCATION_DRIFT) {
    const params = spec.params as AllocationDriftParams;
    if (!ctx.hasTargets) {
      out.error(path, node, "allocation_drift needs buckets and allocation.targets");
    }
    checkBucketList(out, params.buckets, paramsMap, node, path, ctx.bucketIds);
  }
  if (spec.kind === CUSTOM) {
    const params = spec.params as CustomParams;
    if (params.scope === Scope.BUCKET && !ctx.hasTargets) {
      out.error(path, node, "custom rules with scope bucket need buckets and allocation.targets");
    }
    checkBucketList(out, params.buckets, paramsMap, node, path, ctx.bucketIds);
    if (params.expression !== null) {
      const whenNode = paramsMap === null ? null : tree.get(paramsMap, "when");
      for (const [bucketId, column] of bucketReferences(params.expression)) {
        if (ctx.bucketIds.includes(bucketId)) continue;
        out.add(
          "error",
          `${path}.params.when`,
          whenNode ?? node,
          `Unknown bucket "${bucketId}"${bucketHint(bucketId, ctx.bucketIds)} (column ${column} of the expression)`,
          column - 1,
        );
      }
    }
  }
  if (spec.kind === CONTRIBUTION_GAP && !ctx.hasContributions) {
    out.warning(
      path,
      node,
      "contribution_gap needs a contributions: plan; without one the rule is always skipped",
    );
  }
}

function checkBucketList(
  out: Reporter,
  buckets: readonly string[],
  paramsMap: tree.MappingNode | null,
  node: tree.MappingNode,
  path: string,
  bucketIds: readonly string[],
): void {
  for (const bucketId of buckets) {
    if (bucketIds.includes(bucketId)) continue;
    const located = (paramsMap === null ? null : tree.get(paramsMap, "buckets")) ?? node;
    out.error(
      `${path}.params.buckets`,
      located,
      `Unknown bucket "${bucketId}"${bucketHint(bucketId, bucketIds)}`,
    );
  }
}

function bucketHint(bucketId: string, bucketIds: readonly string[]): string {
  if (bucketIds.length === 0) return " (no buckets are defined)";
  return didYouMean(bucketId, bucketIds);
}

/** `_inactive_rules`: rule entries with errors of their own (`rules[i]...` paths), in file order. */
export function inactiveRules(
  root: tree.MappingNode,
  errors: readonly StrategyIssue[],
): InactiveRule[] {
  const byIndex = new Map<number, StrategyIssue[]>();
  for (const issue of errors) {
    const match = RULE_PATH.exec(issue.path);
    if (match === null) continue;
    const index = Number(match[1]);
    const list = byIndex.get(index) ?? [];
    list.push(issue);
    byIndex.set(index, list);
  }
  const node = tree.get(root, "rules");
  const items = node?.kind === "sequence" ? node.value : [];
  return [...byIndex.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const item = items[index] ?? null;
      const raw: PyPlainMap = item?.kind === "mapping" ? tree.plainMap(item) : new Map();
      const ruleId = raw.get("id");
      const kind = raw.get("kind");
      return Object.freeze({
        index,
        ruleId: typeof ruleId === "string" ? ruleId : null,
        kind: typeof kind === "string" ? kind : null,
        line: item === null ? null : tree.position(item)[0],
        issues: byIndex.get(index) ?? [],
      });
    });
}
