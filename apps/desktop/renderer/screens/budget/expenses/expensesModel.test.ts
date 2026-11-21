import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { spendingSlices } from "./expensesModel.js";

beforeEach(() => setLanguageForTests("en"));

const row = (category: string, amount: string) => ({
  category,
  label: category,
  amount: D(amount),
});

describe("spendingSlices", () => {
  it("folds the categories of 1% or less into the rest, summed exactly", () => {
    const { slices } = spendingSlices(
      [row("rent", "900.00"), row("food", "97.80"), row("a", "1.10"), row("b", "1.10")],
      "PLN",
    );
    expect(slices.map((s) => s.key)).toEqual(["rent", "food", "__rest__"]);
    const rest = slices[2];
    expect(rest?.label).toBe("The rest");
    expect(rest?.amount).toContain("2.20");
    expect(rest?.members?.map((m) => m.key)).toEqual(["a", "b"]);
    expect(slices[0]?.share).toBe("90%");
  });

  it("keeps a single small category as it is", () => {
    const { slices } = spendingSlices([row("rent", "990.00"), row("a", "10.00")], "PLN");
    expect(slices.map((s) => s.key)).toEqual(["rent", "a"]);
  });
});
