// The phone's payee and merchant key against the desktop's, row by row, on every built-in bank
// parser's own test fixtures (synthetic statements, `packages/domain/test/fixtures/budget-csv`):
// the same key, and the payee naming the field the key is keyed on. Then the owner's merchant rule:
// refused for a key that names no merchant (empty or a bank's generic phrase), on the phone's
// command and on the desktop's wrapper of it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { budget, normalizeText } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { runQuery } from "../query.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { importStatement, setMerchantCategory } from "./commands.js";
import { budgetTransactionDetail, type CompanionTxnRow } from "./companion-queries.js";
import { setDesktopMerchantCategory } from "./desktop-commands.js";
import { budgetDesktopQueries } from "./desktop-queries.js";

const FIXTURES = fileURLToPath(
  new URL("../../../domain/test/fixtures/budget-csv/", import.meta.url),
);

/** Every parser fixture that parses (the refusal fixtures are the parsers' own concern). */
const CASES: readonly (readonly [budget.BankId, string])[] = [
  ["mbank", "mbank/mbank-zestawienie.csv"],
  ["mbank", "mbank/mbank-ekonto-walutowe-eur.csv"],
  ["mbank", "mbank/mbank-lista-operacji.csv"],
  ["mbank", "mbank/mbank-edge.csv"],
  ["mbank", "mbank/mbank-crlf-bom.csv"],
  ["mbank", "mbank/mbank-utf8.csv"],
  ["mbank", "mbank/mbank-utf8-diacritics.csv"],
  ["mbank", "mbank/mbank-quoted-summary-first.csv"],
  ["mbank", "oracle/test_parsing_mbank.csv"],
  ["erste", "erste/erste-historia.csv"],
  ["erste", "erste/erste-ascending.csv"],
  ["erste", "erste/erste-no-summary.csv"],
  ["erste", "erste/erste-quoted-no-bank.csv"],
  ["erste", "erste/erste-single.csv"],
  ["erste", "erste/santander-legacy.csv"],
  ["pekao", "pekao/pekao-historia.csv"],
  ["pekao", "pekao/pekao-historia-cp1250.csv"],
  ["pekao", "pekao/pekao-cr.csv"],
  ["pekao", "pekao/pekao-eur-row.csv"],
  ["pekao", "pekao/pekao-tie.csv"],
];

function vault(): { store: Store; env: TestEnv } {
  const store = openTestStore();
  const env = testEnv();
  const created = run(store, env, createProfile, {
    slug: "synthetic-payee",
    name: "Synthetic payee",
    baseCurrency: "PLN",
    modules: ["budget"],
  });
  if (!created.ok) throw new Error("synthetic profile refused");
  return { store, env };
}

function importFixture(store: Store, env: TestEnv, bank: budget.BankId, rel: string) {
  const parsed = budget.parseBankStatement(new Uint8Array(readFileSync(FIXTURES + rel)), bank);
  if (!parsed.ok) throw new Error(`fixture ${rel} refused: ${parsed.reason}`);
  const s = parsed.statement;
  const imported = run(store, env, importStatement, {
    statement: {
      bank: s.bank,
      accountNumber: s.accountNumber ?? "99 1140 0000 0000 0000 0000 0099",
      accountName: s.accountName,
      // the edge fixtures keep the file's lower-case `pln` (parser parity); the vault wants a code
      currency: s.currency.toUpperCase(),
      transactions: s.transactions.map((t) => ({ ...t, currency: t.currency.toUpperCase() })),
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
  if (!imported.ok) throw new Error(`fixture ${rel} import refused: ${imported.reason}`);
}

interface Pair {
  readonly phone: CompanionTxnRow;
  readonly desktop: budget.CategoryTxnRow;
}

/** Every bank row as the phone's detail and the desktop's category drill show it. */
function pairs(store: Store): Pair[] {
  const read = store.read.bind(store);
  const drill = budgetDesktopQueries().drill;
  const groups = store.read<{ category: string; currency: string }>(
    `SELECT DISTINCT coalesce(category, 'other') AS category, currency FROM transactions
     WHERE dedup_hash NOT LIKE 'cashleg:%'`,
  );
  const out: Pair[] = [];
  for (const g of groups) {
    for (const desktop of drill.run(read, {
      currency: g.currency,
      category: g.category,
      period: {},
      sort: "date",
      order: "desc",
    })) {
      const detail = runQuery(store, budgetTransactionDetail, { txn: desktop.key, lang: "en" });
      if (detail.value === null) throw new Error("a desktop row the phone does not show");
      out.push({ phone: detail.value.row, desktop });
    }
  }
  return out;
}

describe("phone payee and merchant key == desktop, per parser fixture", () => {
  it.each(CASES)("%s %s", (bank, rel) => {
    const { store, env } = vault();
    try {
      importFixture(store, env, bank, rel);
      const all = pairs(store);
      const rows = store.read<{ n: number }>(
        "SELECT count(*) AS n FROM transactions WHERE dedup_hash NOT LIKE 'cashleg:%'",
      )[0]?.n;
      expect(all.length).toBe(rows);
      expect(all.length).toBeGreaterThan(0);
      for (const { phone, desktop } of all) {
        // the same merchant key (the desktop derives it from the row's text, the phone reads the column)
        expect(phone.merchantKey ?? "").toBe(desktop.merchantKey);
        // the payee is the keyed field: exactly what a rule on that key covers
        expect(normalizeText(phone.payee)).toBe(desktop.merchantKey);
        // the desktop's name for the merchant ("all from ..."), with only mBank's transaction date
        // suffix and location padding cut and whitespace runs (a no-break space) folded on the phone
        const desktopName = (desktop.counterparty || desktop.merchant).replace(/\s+/gu, " ").trim();
        expect(desktopName.startsWith(phone.payee), `${desktopName} / ${phone.payee}`).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("names mBank card payments by the merchant in the title, never the operation type", () => {
    const { store, env } = vault();
    try {
      importFixture(store, env, "mbank", "mbank/mbank-zestawienie.csv");
      const shown = pairs(store)
        .map(({ phone }) => [phone.date, phone.payee, phone.merchantKey] as const)
        .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
      // the oracle is the statement itself (mbank-zestawienie.csv): `#Nadawca/Odbiorca`, else the
      // merchant part of `#Tytuł` (before the padding / the `DATA TRANSAKCJI` suffix)
      expect(shown).toEqual([
        ["2026-09-01", "PRACODAWCA TEST SP. Z O.O.", "PRACODAWCA TEST SP. Z O.O."],
        ["2026-09-02", "KAWIARNIA TEST/WARSZAWA", "KAWIARNIA TEST/WARSZAWA"],
        ["2026-09-02", "KAWIARNIA TEST/WARSZAWA", "KAWIARNIA TEST/WARSZAWA"],
        ["2026-09-03", "JAN TESTOWY", "JAN TESTOWY"],
        ["2026-09-05", "OPŁATA MIESIĘCZNA", "OPLATA MIESIECZNA"],
        ["2026-09-05", "WSPÓLNOTA TEST", "WSPOLNOTA TEST"],
        ["2026-09-08", "SKLEP TEST", "SKLEP TEST"],
        ["2026-09-10", "ANNA TESTOWA", "ANNA TESTOWA"],
      ]);
      for (const { phone } of pairs(store)) {
        expect(phone.payee).not.toMatch(/ZAKUP PRZY|PRZELEW|DATA TRANSAKCJI/);
        expect(budget.isMerchantRuleKey(phone.merchantKey)).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("keys a row with neither counterparty nor title on the bank's phrase, which takes no rule", () => {
    const { store, env } = vault();
    try {
      importFixture(store, env, "mbank", "mbank/mbank-utf8.csv");
      const bare = pairs(store).filter(({ phone }) => !budget.isMerchantRuleKey(phone.merchantKey));
      // mbank-utf8.csv row 2: `PRZELEW` with an empty `#Tytuł` and `#Nadawca/Odbiorca`
      expect(bare.map(({ phone, desktop }) => [phone.payee, desktop.merchantKey])).toEqual([
        ["PRZELEW", "PRZELEW"],
      ]);
    } finally {
      store.close();
    }
  });
});

describe("the owner's merchant rule", () => {
  it.each([
    ["ZAKUP PRZY UŻYCIU KARTY"],
    ["zakup przy uzyciu karty"],
    ["PRZELEW WYCHODZĄCY"],
    ["PRZELEW NA TELEFON BLIK"],
    ["  PRZELEW  "],
  ])("is refused for the generic phrase %j and writes nothing", (merchantKey) => {
    const { store, env } = vault();
    try {
      importFixture(store, env, "mbank", "mbank/mbank-zestawienie.csv");
      const before = store.read("SELECT count(*) AS n FROM category_rules");
      expect(run(store, env, setMerchantCategory, { merchantKey, category: "groceries" })).toEqual({
        ok: false,
        reason: "generic_merchant",
      });
      expect(
        run(store, env, setDesktopMerchantCategory, { merchantKey, category: "groceries" }),
      ).toEqual({ ok: false, reason: "generic_merchant" });
      expect(store.read("SELECT count(*) AS n FROM category_rules")).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("pins a card payment's merchant, and only that merchant's rows follow", () => {
    const { store, env } = vault();
    try {
      importFixture(store, env, "mbank", "mbank/mbank-zestawienie.csv");
      const key = pairs(store).find(({ phone }) => phone.payee === "SKLEP TEST")?.phone.merchantKey;
      expect(key).toBe("SKLEP TEST");
      const out = run(store, env, setMerchantCategory, {
        merchantKey: key,
        category: "groceries",
      });
      expect(out.ok).toBe(true);
      const filed = store.read<{ reference: string }>(
        "SELECT reference FROM transactions WHERE category = 'groceries' ORDER BY id",
      );
      expect(filed.map((r) => r.reference)).toEqual([
        "SKLEP TEST   /KRAKÓW   DATA TRANSAKCJI: 2026-09-06",
      ]);
    } finally {
      store.close();
    }
  });
});
