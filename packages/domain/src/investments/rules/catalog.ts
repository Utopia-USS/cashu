/** The catalog of rule kinds the strategy loader accepts (`rules/catalog.py`). */

import type { RuleKind } from "./kind.js";
import { allocationDriftRule } from "./kinds/allocationDrift.js";
import { cashLevelRule } from "./kinds/cashLevel.js";
import { contributionGapRule } from "./kinds/contributionGap.js";
import { customRule } from "./kinds/custom.js";
import { drawdownFromHighRule } from "./kinds/drawdownFromHigh.js";
import { positionConcentrationRule } from "./kinds/positionConcentration.js";
import { taggedWeightRule } from "./kinds/taggedWeight.js";
import { gainFromCostRule, lossFromCostRule } from "./kinds/unrealizedFromCost.js";

export const BUILT_IN_KINDS = [
  "allocation_drift",
  "position_concentration",
  "loss_from_cost",
  "gain_from_cost",
  "drawdown_from_high",
  "cash_level",
  "contribution_gap",
  "tagged_weight",
  "custom",
] as const;

/** Rule kinds by their `kind:` name, in registration order. */
export class RuleCatalog {
  private readonly byName = new Map<string, RuleKind>();

  /** The built-in kinds (see `BUILT_IN_KINDS`). */
  static builtIn(): RuleCatalog {
    const catalog = new RuleCatalog();
    for (const kind of [
      allocationDriftRule,
      positionConcentrationRule,
      lossFromCostRule,
      gainFromCostRule,
      drawdownFromHighRule,
      cashLevelRule,
      contributionGapRule,
      taggedWeightRule,
      customRule,
    ] as readonly RuleKind[]) {
      catalog.register(kind);
    }
    return catalog;
  }

  /** Adds `kind`; throws when its name is already registered. */
  register(kind: RuleKind): void {
    if (this.byName.has(kind.kind)) {
      throw new Error(`Rule kind '${kind.kind}' is already registered`);
    }
    this.byName.set(kind.kind, kind);
  }

  /** Registered kind names, in registration order. */
  get kinds(): readonly string[] {
    return [...this.byName.keys()];
  }

  get(kind: string): RuleKind | null {
    return this.byName.get(kind) ?? null;
  }

  has(kind: string): boolean {
    return this.byName.has(kind);
  }
}
