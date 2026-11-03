import { loadStrategy } from "@cashu/domain/investments/strategy";
import { safeLoadYaml } from "@cashu/domain/pyYaml";
import { expect, it } from "vitest";
import vectors from "./fixtures/proposalRuleText.json" with { type: "json" };
import {
  checkResultingStrategy,
  existingProposalRuleIds,
  mergeProposalRule,
  proposalRuleEntry,
  renderProposalRule,
  StrategyProposalError,
} from "./proposalRuleText.js";

it.each(vectors.renders)(
  "matches actual Python rendering and merge for $entry.params.message",
  ({ entry, rendered, merges }) => {
    expect(renderProposalRule(entry)).toBe(rendered);
    expect(safeLoadYaml(renderProposalRule(entry))).toEqual(safeLoadYaml(rendered));
    for (const merge of merges) {
      const actual = mergeProposalRule(merge.yaml, entry);
      expect(actual).toBe(merge.expected);
      expect(safeLoadYaml(actual)).toEqual(safeLoadYaml(merge.expected));
    }
  },
);
it.each(vectors.entries)(
  "matches actual Python rule metadata $kind",
  ({ kind, params, ids, expected }) => {
    if (expected.ok)
      expect({ ok: true, ...proposalRuleEntry(kind, params, new Set(ids)) }).toEqual(expected);
    else expect(() => proposalRuleEntry(kind, params, new Set(ids))).toThrow(expected.message);
  },
);
it.each(vectors.ids)("reads existing IDs from source YAML", ({ yaml, expected }) => {
  expect([...existingProposalRuleIds(yaml)].sort()).toEqual(expected);
});
it.each(vectors.validations)(
  "preserves partial/resulting strategy semantics",
  ({ before, after, own, expected }) => {
    if (expected.ok)
      expect({
        ok: true,
        warnings: checkResultingStrategy(
          loadStrategy(after, null),
          loadStrategy(before, null),
          own ?? undefined,
        ),
      }).toEqual(expected);
    else {
      try {
        checkResultingStrategy(
          loadStrategy(after, null),
          loadStrategy(before, null),
          own ?? undefined,
        );
        throw new Error("expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(StrategyProposalError);
        expect({
          ok: false,
          code: (error as StrategyProposalError).code,
          message: (error as Error).message,
        }).toEqual(expected);
      }
    }
  },
);
