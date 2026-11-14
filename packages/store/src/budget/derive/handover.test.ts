// The budget derivers hand state to the ones after them inside one apply (transfers -> categories:
// the flipped transfer flags; categories -> recurring and months: the changed rows; legs -> months:
// the cash legs). A deriver runs only when one of its inputs is dirty, so a taker must list every
// input of each giver and come after it: otherwise a change waits in the hand-over table until some
// later apply while the live queries already woke on `transactions`.
import { describe, expect, it } from "vitest";
import type { Deriver } from "../../engine/types.js";
import { budgetModule } from "../index.js";
import { categoriesDeriver } from "./categories.js";
import { legsDeriver } from "./legs.js";
import { monthsDeriver } from "./months.js";
import { recurringDeriver } from "./recurring.js";
import { transfersDeriver } from "./transfers.js";

const HANDOVERS: readonly (readonly [giver: Deriver, taker: Deriver])[] = [
  [transfersDeriver, categoriesDeriver],
  [categoriesDeriver, recurringDeriver],
  [categoriesDeriver, monthsDeriver],
  [legsDeriver, monthsDeriver],
];

describe("deriver hand-overs", () => {
  it.each(HANDOVERS.map(([g, t]) => [g.id, t.id, g, t] as const))(
    "%s -> %s: the taker inputs every input of the giver and runs after it",
    (_g, _t, giver, taker) => {
      expect(new Set(taker.inputs)).toEqual(new Set([...taker.inputs, ...giver.inputs]));
      const order = (budgetModule.derivers ?? []).map((d) => d.id);
      expect(order.indexOf(giver.id)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(giver.id)).toBeLessThan(order.indexOf(taker.id));
    },
  );

  it("budget.recurring reads the category changes before budget.months takes them", () => {
    // the reader without taking (recurring) must run between the giver and the taker (months)
    const order = (budgetModule.derivers ?? []).map((d) => d.id);
    expect(order.indexOf(categoriesDeriver.id)).toBeLessThan(order.indexOf(recurringDeriver.id));
    expect(order.indexOf(recurringDeriver.id)).toBeLessThan(order.indexOf(monthsDeriver.id));
    // the inputs are the same array (by reference, never a hand copy that can drift)
    expect(recurringDeriver.inputs).toBe(categoriesDeriver.inputs);
  });
});
