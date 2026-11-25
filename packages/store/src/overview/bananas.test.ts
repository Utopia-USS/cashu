// The phone's banana scale entry (`@cashu/store/overview/bananas`): the query factory there is the
// one the overview barrel uses (one id, one definition) and answers what `bananaScaleView` computes.
// Synthetic household only.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { importStatement } from "../budget/commands.js";
import { createProfile } from "../core/commands.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { bananaScaleQuery, bananaScaleView } from "./bananas.js";
import { overviewQueries } from "./index.js";

const TODAY = "2026-10-01";

/** A budget vault paid 9000 on the 10th of June to September. */
function salaried() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, { slug: "synthetic", name: "Synthetic", modules: ["budget"] });
  const transactions: RawTransaction[] = ["06", "07", "08", "09"].map((m, i) => ({
    bookingDate: `2026-${m}-10`,
    valueDate: null,
    amount: D("9000.00"),
    currency: "PLN",
    counterpartyName: "PRACODAWCA TEST",
    counterpartyIban: null,
    description: `WYNAGRODZENIE ${m}`,
    reference: `WYNAGRODZENIE ${m}`,
    bankTransactionId: `SYN-${i}`,
    source: "csv",
    raw: { row: i },
  }));
  const imported = run(store, env, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: "99114000000000000000000001",
      accountName: "Synthetic",
      currency: "PLN",
      transactions,
      balances: [],
      closingBalances: [],
    },
  });
  if (!imported.ok) throw new Error(`synthetic import refused: ${imported.reason}`);
  return store;
}

describe("bananaScaleQuery", () => {
  it("answers the scale of the vault under the overview's id", () => {
    const store = salaried();
    const query = bananaScaleQuery({ prices: null });
    expect(query.id).toBe("core.bananaScale");
    expect(overviewQueries({ prices: null }).bananaScale.id).toBe(query.id);
    const scale = runQuery(store, query, { today: TODAY }).value;
    expect(scale?.anchor).toBe("salary");
    expect(scale).toEqual(bananaScaleView(store.read.bind(store), { today: TODAY, prices: null }));
    expect(
      runQuery(store, overviewQueries({ prices: null }).bananaScale, { today: TODAY }).value,
    ).toEqual(scale);
  });

  it("is null without a salary or a portfolio", () => {
    const store = openTestStore();
    expect(runQuery(store, bananaScaleQuery({ prices: null }), { today: TODAY }).value).toBeNull();
  });
});
