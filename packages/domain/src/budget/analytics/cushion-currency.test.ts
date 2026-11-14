// The cushion level (month close on the overview and the phone) rolls a balance forward over the
// account's own-currency rows only (data-safety rule 5): a row in another currency on a cushion account
// (a foreign or malformed event) never moves a level in the account's currency. Synthetic household
// (testing/seedDemo.ts), September 2026 on "mKonto Test", as in cushion.test.ts.

import { describe, expect, it } from "vitest";
import { monthClose } from "./monthClose.js";
import { monthCloseView } from "./monthCloseView.js";
import { parseBudgetSettings } from "./settings.js";
import { seedDemo } from "./testing/seedDemo.js";

function cushionBalance(foreign: boolean): string | undefined {
  const h = seedDemo();
  const main = h.accountId("mKonto Test");
  // 08-20 snapshot 5200; after it in August: -208 fuel, -55 unknown shop, -7 fee: 4930 at the start
  h.balance(main, "2026-08-20", "5200.00");
  if (foreign)
    h.ingest(main, [
      {
        date: "2026-08-25",
        amount: "-50.00",
        currency: "EUR",
        cp: "SYNTHETIC EURO SHOP",
        desc: "synthetic euro row",
        ref: "synthetic euro row",
      },
    ]);
  const parsed = parseBudgetSettings({ cushion: { enabled: true, target_amount: 5000 } });
  if (!parsed.ok) throw new Error(parsed.error);
  const settings = { cushion: { ...parsed.settings.cushion, accountIds: [main] } };
  const view = monthCloseView(
    monthClose(h.book(), {
      year: 2026,
      month: 9,
      today: "2026-10-15",
      settings,
      env: h.env(),
      investmentsEnabled: false,
      planned: null,
    }),
  );
  return view.cushion?.balance.toString();
}

describe("cushion level per currency", () => {
  it("ignores a cushion account's row in another currency", () => {
    // hand-computed in cushion.test.ts: 4930 - 1300 + 40 = 3670.00; the EUR row would make it 3620.00
    expect(cushionBalance(false)).toBe("3670.00");
    expect(cushionBalance(true)).toBe("3670.00");
  });
});
