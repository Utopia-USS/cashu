/**
 * Shipped strategy templates (`templates/__init__.py`): `<name>.yaml` + `<name>.md` default strategy
 * files a new profile copies and edits; `README.md` is the strategy.yaml reference. The texts are
 * embedded in `templates.data.ts`, their source of truth.
 */

import { STRATEGY_TEMPLATE_FILES } from "./templates.data.js";

/** Strategy templates in display order. */
export const STRATEGY_TEMPLATE_NAMES = ["passive_etf", "blank"] as const;
export type StrategyTemplateName = (typeof STRATEGY_TEMPLATE_NAMES)[number];

export interface StrategyTemplate {
  readonly name: StrategyTemplateName;
  /** strategy.yaml text (comments in English). */
  readonly yaml: string;
  /** strategy.md text (prose, in Polish). */
  readonly markdown: string;
}

export function isStrategyTemplateName(name: string): name is StrategyTemplateName {
  return (STRATEGY_TEMPLATE_NAMES as readonly string[]).includes(name);
}

/** `strategy_template(name)`; null for an unknown name (Python raises `KeyError`). */
export function strategyTemplate(name: string): StrategyTemplate | null {
  if (!isStrategyTemplateName(name)) return null;
  return {
    name,
    yaml: STRATEGY_TEMPLATE_FILES[`${name}.yaml`] ?? "",
    markdown: STRATEGY_TEMPLATE_FILES[`${name}.md`] ?? "",
  };
}

/** `strategy_reference()`: the strategy.yaml reference. */
export function strategyReference(): string {
  return STRATEGY_TEMPLATE_FILES["README.md"] ?? "";
}
