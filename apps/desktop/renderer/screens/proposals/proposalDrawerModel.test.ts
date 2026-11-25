// The drawer names the host's specific strategy refusal (Python showed the code's label), in Polish
// and English, in the same error line as every other refusal.
import { lang, setLanguageForTests } from "@cashu/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { P } from "./ProposalDrawer.strings.js";
import { proposalDrawerModel } from "./proposalDrawerModel.js";
import { strategyRefusal } from "./proposalRefusals.js";
import type { ProposalDrawerState } from "./useProposalDrawer.js";

const state = (message: ProposalDrawerState["message"]): ProposalDrawerState => ({
  detail: null,
  busy: false,
  message,
  failure: "",
  onApproved: async () => {},
  onRejected: async () => {},
});

const initial = lang();
afterEach(() => setLanguageForTests(initial));

describe("proposal drawer refusals", () => {
  it.each([
    ["rule_exists", "ruleExists"],
    ["base_changed", "baseChanged"],
    ["strategy_missing", "strategyMissing"],
    ["rule_invalid", "ruleInvalid"],
  ] as const)("shows %s as its own text", (reason, key) => {
    expect(strategyRefusal(reason)).toBe(key);
    for (const language of ["pl", "en"] as const) {
      setLanguageForTests(language);
      const error = proposalDrawerModel(state(strategyRefusal(reason))).error;
      expect(error?.text).toBe(P[key]);
      expect(error?.text).not.toBe(P.refused);
    }
  });

  it("keeps the generic text for any other reason", () => {
    expect(strategyRefusal("preparation_failed")).toBe("refused");
    expect(strategyRefusal("toString")).toBe("refused");
  });
});
