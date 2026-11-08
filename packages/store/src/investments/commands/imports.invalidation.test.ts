// Touched-table invalidation for the S22b import and decision commands (testing.md): each batch
// touches a table the matching query reads, a subscriber is notified, the answer changed. Synthetic.
import { sha256Hex } from "@cashu/domain";
import { describe, it } from "vitest";
import { importBatches } from "../queries/import-preview.js";
import { decisions } from "../queries/journal.js";
import { signalByGid } from "../queries/signals.js";
import { transactions } from "../queries/transactions.js";
import { addBrokerageAccount } from "./accounts.js";
import { acknowledgeSignal, decidePosition, decideSignal } from "./decisions.js";
import { commitImport } from "./imports.js";
import { applyRaw, raw, rawGid, stock, vault } from "./testing/fixtures.js";
import { expectInvalidates } from "./testing/invalidation.js";

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price," +
  "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source";
const file = (lines: string[]) => new TextEncoder().encode(`${[HEADER, ...lines].join("\n")}\n`);

describe("S22b import and decision batches invalidate the queries that read their tables", () => {
  it("commitImport", () => {
    const v = vault();
    const account = v.value(addBrokerageAccount, { name: "Konto", broker: "dif" }).account;
    const content = file([
      "1,txn,2026-01-07,,buy,T-2,ABC,PLABC0000016,ABC Example SA,XWAR,100,50.00,PLN,5000.00,,,-5000.00,,,,",
      "1,position,2026-02-27,,,,ABC,PLABC0000016,ABC Example SA,XWAR,90,,PLN,,,,,,,,",
    ]);
    const archive = { sha256: sha256Hex(content), ext: "csv" };
    expectInvalidates(
      v,
      commitImport,
      { account, file: { name: "a.csv", content }, archive },
      (r) => [transactions(r), importBatches(r)],
    );
  });

  it("decidePosition, decideSignal and acknowledgeSignal", () => {
    const v = vault();
    const xmpl = stock(v, "XMPL", "US0000000001");
    const [a, b, c] = [rawGid(1), rawGid(2), rawGid(3)];
    applyRaw(v, [
      raw.signalOpened(a, `r1|i:${xmpl}`, { instrument: xmpl }),
      raw.signalOpened(b, `r2|i:${xmpl}`, { instrument: xmpl }),
      raw.signalOpened(c, `r3|i:${xmpl}`, { instrument: xmpl }),
    ]);
    expectInvalidates(v, decidePosition, { instrument: xmpl, action: "held", signals: [a] }, (r) =>
      signalByGid(r, a),
    );
    expectInvalidates(v, decideSignal, { signal: b, action: "other" }, (r) => decisions(r));
    expectInvalidates(v, acknowledgeSignal, { signal: c }, (r) => signalByGid(r, c));
  });
});
