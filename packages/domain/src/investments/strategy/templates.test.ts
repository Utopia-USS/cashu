/// <reference types="node" />
// Port of tests/investments/strategy/test_strategy_templates.py: the shipped strategy templates load
// without issues; the .md templates are Polish prose; no em dashes. Plus the TypeScript-only check that
// the generated templates.data.ts is current with the Python app's template folder.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strategyTemplatesSource, templateFiles } from "../../../scripts/strategyTemplateSource.js";
import { SignalSeverity } from "../domain/enums.js";
import { BUILT_IN_KINDS } from "../rules/index.js";
import {
  errorsOf,
  issueText,
  loadStrategy,
  STRATEGY_TEMPLATE_NAMES,
  type StrategyTemplate,
  strategyReference,
  strategyTemplate,
  TOP_LEVEL_KEYS,
  Weekday,
} from "./index.js";
import { STRATEGY_TEMPLATE_FILES } from "./templates.data.js";
import { configOf, splitLines } from "./testing/load.js";

const EM_DASH = String.fromCodePoint(0x2014);

function template(name: string): StrategyTemplate {
  const found = strategyTemplate(name);
  expect(found, name).not.toBeNull();
  if (found === null) throw new Error(`no template ${name}`);
  return found;
}

describe("templates.data.ts", () => {
  it("is generated from the Python template folder, byte for byte", () => {
    const committed = readFileSync(new URL("./templates.data.ts", import.meta.url), "utf8");
    expect(
      committed === strategyTemplatesSource(),
      "templates.data.ts is stale: run pnpm --filter @cashu/domain gen:strategy-templates",
    ).toBe(true);
    expect(STRATEGY_TEMPLATE_FILES).toEqual(Object.fromEntries(templateFiles()));
  });
});

describe("test_strategy_templates", () => {
  it("test_every_yaml_template_has_a_md_partner_and_is_listed", () => {
    const names = [...templateFiles().keys()];
    const yamlNames = names
      .filter((n) => n.endsWith(".yaml"))
      .map((n) => n.slice(0, -".yaml".length))
      .sort();
    const mdNames = names
      .filter((n) => n.endsWith(".md") && n !== "README.md")
      .map((n) => n.slice(0, -".md".length))
      .sort();
    const listed = [...STRATEGY_TEMPLATE_NAMES].sort();
    expect(yamlNames).toEqual(mdNames);
    expect(mdNames).toEqual(listed);
  });

  it.each(STRATEGY_TEMPLATE_NAMES)("test_template_loads_without_issues[%s]", (name) => {
    const t = template(name);
    const result = loadStrategy(t.yaml, t.markdown);
    expect(result.issues.map(issueText)).toEqual([]);
    expect(result.config).not.toBeNull();
  });

  it("test_passive_etf_is_a_complete_starter", () => {
    const config = configOf(loadStrategy(template("passive_etf").yaml));
    expect(config.allocation.buckets.map((b) => b.id)).toEqual([
      "global_equity",
      "bond_etfs",
      "treasury_bonds",
      "cash",
    ]);
    let total = 0;
    for (const weight of config.allocation.targets.values()) total += weight;
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(config.rules.map((r) => r.kind)).toEqual([
      "allocation_drift",
      "position_concentration",
      "cash_level",
      "drawdown_from_high",
      "contribution_gap",
      "custom",
    ]);
    expect(config.contributions).not.toBeNull();
    expect(config.benchmark).not.toBeNull();
    expect(config.benchmark?.currency).toBe("PLN");
    expect(config.notifications.immediate).toEqual(new Set([SignalSeverity.ACTION]));
    expect(config.notifications.digestWeekday).toBe(Weekday.SUNDAY);
  });

  it("test_blank_is_valid_with_no_rules_and_no_buckets", () => {
    const config = configOf(loadStrategy(template("blank").yaml));
    expect(config.rules).toEqual([]);
    expect(config.allocation.buckets).toEqual([]);
    expect(config.benchmark).toBeNull();
  });

  it("test_the_commented_examples_in_blank_are_valid_when_uncommented", () => {
    const topLevel: readonly string[] = TOP_LEVEL_KEYS;
    const lines: string[] = [];
    let active = false;
    for (const line of splitLines(template("blank").yaml)) {
      if (line.startsWith("rules: []")) continue;
      const match = /^# (([a-z_]+):.*)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && topLevel.includes(match[2])) {
        active = true;
        lines.push(match[1]);
      } else if (active && line.startsWith("#   ")) {
        lines.push(line.slice(2));
      } else {
        active = false;
        lines.push(line);
      }
    }
    const result = loadStrategy(`${lines.join("\n")}\n`);
    expect(errorsOf(result).map(issueText)).toEqual([]);
    const config = configOf(result);
    expect(new Set(config.rules.map((r) => r.kind))).toEqual(
      new Set([
        "allocation_drift",
        "position_concentration",
        "loss_from_cost",
        "contribution_gap",
        "tagged_weight",
        "custom",
      ]),
    );
    expect(config.benchmark).not.toBeNull();
    expect(config.watchlist.values.get("max_pe")).toBe(20);
  });

  it("test_md_templates_are_polish_prose_with_the_guiding_headings", () => {
    for (const name of STRATEGY_TEMPLATE_NAMES) {
      const markdown = template(name).markdown;
      for (const heading of [
        "## Cel",
        "## Horyzont",
        "## Tolerancja ryzyka",
        "## Zasady wejścia i wyjścia",
        "## Czego unikam",
      ]) {
        expect(markdown, `${name} ${heading}`).toContain(heading);
      }
      expect(markdown).not.toContain("Kompas");
    }
  });

  it("test_readme_documents_every_key_and_rule_kind", () => {
    const readme = strategyReference();
    for (const key of TOP_LEVEL_KEYS) expect(readme, key).toContain(`\`${key}\``);
    for (const kind of BUILT_IN_KINDS) expect(readme, kind).toContain(`\`${kind}\``);
    for (const key of [
      "max_price_age_days",
      "max_stale_weight",
      "max_unclassified_weight",
      "max_fx_age_days",
    ]) {
      expect(readme, key).toContain(`\`${key}\``);
    }
  });

  it("test_no_em_dash_anywhere_in_the_templates", () => {
    for (const [name, text] of templateFiles()) expect(text.includes(EM_DASH), name).toBe(false);
  });

  it("test_unknown_template_name", () => {
    // Python raises KeyError("Unknown strategy template ..."); the port returns null
    expect(strategyTemplate("aggressive")).toBeNull();
  });
});
