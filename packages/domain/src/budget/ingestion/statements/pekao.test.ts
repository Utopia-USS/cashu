import { describe, expect, it } from "vitest";
import { InstitutionRegistry } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import { fixtureBytes } from "../testing/fixtures.js";
import { detectBank, parseBankStatement, parseStatementFile } from "./registry.js";

const registry = new InstitutionRegistry();

// tests/test_pekao.py (input: the Python constant written as UTF-8 by the generator)
describe("test_pekao.py", () => {
  // test_detect_and_parse_pekao
  it("detects Pekao, infers the own account and resolves each counterparty", () => {
    const bytes = fixtureBytes("oracle/test_pekao.csv");
    expect(detectBank(bytes, registry)).toBe("pekao");
    const r = parseStatementFile(bytes, registry);
    if (!r.ok) throw new Error(r.reason);
    const stmt = r.statement;
    expect(stmt.bank).toBe("pekao");
    expect([stmt.accountNumber, stmt.accountNumberOrigin]).toEqual([
      "10000000000000000000000002",
      "inferred",
    ]);
    expect(stmt.transactions.length).toBe(3);
    const [incoming, repayment, blik] = stmt.transactions;
    expect(incoming?.amount.eq(D("50.00"))).toBe(true);
    expect(incoming?.counterpartyIban).toBe("10000000000000000000000001");
    expect(repayment?.amount.eq(D("-1540.00"))).toBe(true);
    expect(repayment?.counterpartyIban).toBe("10000000000000000000000003");
    expect(blik?.amount.eq(D("125.00"))).toBe(true);
    expect(stmt.balances).toEqual([]);
  });

  it("Q12: the statement currency stays PLN while a row keeps its EUR", () => {
    const r = parseBankStatement(fixtureBytes("pekao/pekao-eur-row.csv"), "pekao");
    if (!r.ok) throw new Error(r.reason);
    expect(r.statement.currency).toBe("PLN");
    expect(r.statement.transactions.map((t) => t.currency)).toEqual(["EUR", "PLN"]);
  });
});
