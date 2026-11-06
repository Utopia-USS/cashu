// The in-app statement import (preview -> commit) and the first steps' `Dopasuj` against the Python
// oracle (ab24ab6 modules/budget/imports.py + POST /budget/match-transfers). The expected values come
// from running the frozen Python app (parity/python/oracle, CASHU_LANG=pl) through the same sequence
// on the same synthetic files: preview A, commit A, preview A again, preview / commit an overlapping
// A2, preview / commit the savings account B (one transfer between A and B), the refusals, a cashU format
// document (overlap by the newest-day rule) and one in another currency, then match
// transfers (nothing left) and match after a reset (the one pair). Synthetic data only.
import { describe, expect, it } from "vitest";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { matchTransfersCommand } from "./commands.js";
import { matchDesktopTransfers } from "./desktop-commands.js";
import { budgetDesktopQueries } from "./desktop-queries.js";
import {
  batchCategorized,
  commitStatementImport,
  previewStatement,
  type StatementCommitResult,
  type StatementPreview,
  type StatementRequest,
  transferPairCount,
} from "./statement-import.js";

const MBANK_HEAD =
  "mBank S.A. Bankowość Detaliczna;\n\n#Waluta;\nPLN;\n\n#Numer rachunku;\n99 1140 0000 0000 0000 0000 0001;\n\n" +
  "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;\n";
const SHOP = `2026-09-02;2026-09-02;ZAKUP PRZY UŻYCIU KARTY;"SKLEP TEST";"SKLEP TEST";'';-84,20;`;
const OWN = `2026-09-10;2026-09-10;PRZELEW WŁASNY;"OSZCZĘDNOŚCI";"JAN TESTOWY";'99124000000000000000000002';-1 000,00;4 831,60;\n`;
const FILES: Record<string, string> = {
  "mbank-a.csv":
    MBANK_HEAD +
    `2026-09-01;2026-09-01;PRZELEW PRZYCHODZĄCY;"WYNAGRODZENIE 08/2026";"PRACODAWCA TEST";'99102000000000000000000777';5 000,00;6 000,00;\n` +
    `${SHOP}5 915,80;\n${SHOP}5 831,60;\n${OWN}` +
    `2026-09-11;2026-09-11;ZAKUP;"BEZ KWOTY";"X";'';;4 831,60;\n`,
  "mbank-a2.csv":
    MBANK_HEAD +
    `${SHOP}5 831,60;\n${OWN}` +
    `2026-09-15;2026-09-15;ZAKUP PRZY UŻYCIU KARTY;"KAWIARNIA TEST";"KAWIARNIA TEST";'';-20,00;4 811,60;\n`,
  "pekao-b.csv":
    "Data księgowania;Data waluty;Nadawca / Odbiorca;Adres nadawcy / odbiorcy;Rachunek źródłowy;Rachunek docelowy;Tytułem;Kwota operacji;Waluta;Numer referencyjny;Typ operacji;Kategoria\n" +
    "10.09.2026;10.09.2026;JAN TESTOWY;;'99114000000000000000000001;'99124000000000000000000002;OSZCZĘDNOŚCI;1 000,00;PLN;C0000000000001;PRZELEW WŁASNY;Przelewy\n" +
    "12.09.2026;12.09.2026;SKLEP TEST;KRAKÓW;'99124000000000000000000002;;SKLEP TEST KRAKÓW;-50,00;PLN;C0000000000002;TRANSAKCJA KARTĄ PŁATNICZĄ;Zakupy\n",
  "garbage.csv": "hello;world\n1;2\n",
  "doc.json": JSON.stringify({
    format: "cashu-budget-import",
    format_version: 1,
    source: "my_converter",
    account: { iban: "99114000000000000000000001", currency: "PLN", institution: "mbank" },
    transactions: [
      {
        booking_date: "2026-09-02",
        amount: "-84.20",
        currency: "PLN",
        counterparty_name: "SKLEP TEST",
        reference: "SKLEP TEST",
      },
      { booking_date: "2026-09-05", amount: "-10.00", currency: "PLN", counterparty_name: "INNY" },
      { booking_date: "2026-09-20", amount: "-5.00", currency: "PLN", counterparty_name: "NOWY" },
    ],
  }),
  "doc-eur.json": JSON.stringify({
    format: "cashu-budget-import",
    format_version: 1,
    account: { iban: "99114000000000000000000001", currency: "EUR", institution: "mbank" },
    transactions: [{ booking_date: "2026-09-20", amount: "-5.00", currency: "EUR" }],
  }),
};
const request = (fileName: string, extra: Partial<StatementRequest> = {}): StatementRequest => ({
  fileName,
  content: new TextEncoder().encode(FILES[fileName]),
  lang: "pl",
  ...extra,
});

function setup() {
  const store = openTestStore();
  const env = testEnv();
  const read = store.read.bind(store);
  const preview = (fileName: string, extra: Partial<StatementRequest> = {}) =>
    previewStatement(read, request(fileName, extra));
  const shown = (fileName: string, extra: Partial<StatementRequest> = {}) => {
    const r = preview(fileName, extra);
    if (!r.ok) throw new Error(r.code);
    return r.preview;
  };
  /** The host's commit: the command, then the derived facts the done line reads. */
  const commit = (fileName: string, extra: Partial<StatementRequest> = {}) => {
    const req = request(fileName, extra);
    const p = previewStatement(read, req);
    if (!p.ok) throw new Error(p.code);
    const before = transferPairCount(read);
    const out = run(store, env, commitStatementImport, {
      fileName,
      content: req.content,
      sha256: p.preview.sha256,
      importer: p.preview.importer.id,
      accountType: req.accountType,
      accountName: req.accountName,
      account: req.account,
      lang: "pl",
    });
    if (!out.ok) throw new Error(out.reason);
    const value = out.value as StatementCommitResult;
    return {
      ...value,
      categorized: batchCategorized(read, value.batch),
      transferPairs: transferPairCount(read) - before,
    };
  };
  return { store, env, read, preview, shown, commit };
}

const statuses = (p: StatementPreview) => p.rows.map((r) => r.status);

describe("statement import (Python oracle sequence)", () => {
  it("previews, commits, dedups, pairs the transfer and refuses like Python", () => {
    const t = setup();
    // s1: a new mBank account, the row without an amount skipped
    const s1 = t.shown("mbank-a.csv", { importer: "auto", accountType: "checking" });
    expect(s1.importer).toEqual({ id: "mbank", detected: true });
    expect(s1.account).toEqual({
      existing: false,
      gid: null,
      name: "mBank 0001",
      currency: "PLN",
      ibanTail: "0001",
      transactions: 0,
      institution: { id: "mbank", name: "mBank" },
      rememberedImporter: null,
    });
    expect(s1.counts).toEqual({ rows: 5, new: 4, duplicates: 0, overlap: 0, skipped: 1 });
    expect(s1.range).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(s1.balances).toBe(3);
    expect(s1.previousImports).toEqual([]);
    expect(s1.warnings).toEqual([]);
    expect(
      s1.rows.map((r) => [r.row, r.date, r.amount.toString(), r.title, r.counterparty, r.status]),
    ).toEqual([
      [1, "2026-09-01", "5000.00", "WYNAGRODZENIE 08/2026", "PRACODAWCA TEST", "new"],
      [2, "2026-09-02", "-84.20", "SKLEP TEST", "SKLEP TEST", "new"],
      [3, "2026-09-02", "-84.20", "SKLEP TEST", "SKLEP TEST", "new"],
      [4, "2026-09-10", "-1000.00", "OSZCZĘDNOŚCI", "JAN TESTOWY", "new"],
    ]);

    // c1
    const c1 = t.commit("mbank-a.csv", { importer: "mbank", accountType: "checking" });
    expect(c1).toMatchObject({
      account: { name: "mBank 0001", currency: "PLN", ibanTail: "0001", created: true },
      inserted: 4,
      duplicates: 0,
      skipped: 1,
      balances: 3,
      categorized: 0,
      transferPairs: 0,
    });

    // s2: the same file again: all duplicates, the earlier import of these bytes
    const s2 = t.shown("mbank-a.csv", { importer: "auto", accountType: "checking" });
    expect(s2.account).toMatchObject({
      existing: true,
      gid: c1.account.gid,
      transactions: 4,
      rememberedImporter: "mbank",
    });
    expect(s2.counts).toEqual({ rows: 5, new: 0, duplicates: 4, overlap: 0, skipped: 1 });
    expect(
      s2.previousImports.map(({ fileName, inserted, sameFile }) => ({
        fileName,
        inserted,
        sameFile,
      })),
    ).toEqual([{ fileName: "mbank-a.csv", inserted: 4, sameFile: true }]);

    // s3 / c2: an overlapping file: one of the two equal card rows and the transfer are known
    const s3 = t.shown("mbank-a2.csv", { importer: "mbank", accountType: "checking" });
    expect(s3.importer).toEqual({ id: "mbank", detected: false });
    expect(s3.counts).toEqual({ rows: 3, new: 1, duplicates: 2, overlap: 0, skipped: 0 });
    expect(statuses(s3)).toEqual(["duplicate", "duplicate", "new"]);
    expect(s3.previousImports).toEqual([]);
    const c2 = t.commit("mbank-a2.csv", { importer: "mbank", accountType: "checking" });
    expect(c2).toMatchObject({
      account: { created: false, name: "mBank 0001" },
      inserted: 1,
      duplicates: 2,
      skipped: 0,
      balances: 3,
      categorized: 1,
      transferPairs: 0,
    });

    // s4 / c3: the savings account at another bank, named by the owner; the transfer pairs
    const s4 = t.shown("pekao-b.csv", {
      importer: "auto",
      accountType: "savings",
      accountName: "Oszczędności",
    });
    expect(s4.importer).toEqual({ id: "pekao", detected: true });
    expect(s4.account).toMatchObject({
      existing: false,
      name: "Oszczędności",
      ibanTail: "0002",
      institution: { id: "pekao", name: "Bank Pekao" },
    });
    expect(s4.counts).toEqual({ rows: 2, new: 2, duplicates: 0, overlap: 0, skipped: 0 });
    expect(s4.range).toEqual({ from: "2026-09-10", to: "2026-09-12" });
    expect(s4.balances).toBe(0);
    const c3 = t.commit("pekao-b.csv", {
      importer: "pekao",
      accountType: "savings",
      accountName: "Oszczędności",
    });
    expect(c3).toMatchObject({
      account: { created: true, name: "Oszczędności", ibanTail: "0002" },
      inserted: 2,
      duplicates: 0,
      balances: 0,
      categorized: 1,
      transferPairs: 1,
    });

    // refusals
    expect(t.preview("garbage.csv", { importer: "auto" })).toMatchObject({
      ok: false,
      code: "import_bank_unknown",
    });
    expect(t.preview("mbank-a.csv", { accountType: "loan" })).toMatchObject({
      ok: false,
      code: "import_account_type",
    });
    expect(t.preview("mbank-a.csv", { importer: "mbank", account: c3.account.gid })).toMatchObject({
      ok: false,
      code: "import_account_mismatch",
    });

    // into an existing account picked in the select
    const into = t.shown("mbank-a2.csv", { importer: "mbank", account: c1.account.gid });
    expect(into.account).toMatchObject({
      existing: true,
      transactions: 5,
      rememberedImporter: "mbank",
    });
    expect(into.counts).toEqual({ rows: 3, new: 0, duplicates: 3, overlap: 0, skipped: 0 });
    expect(into.previousImports.map((p) => [p.fileName, p.inserted, p.sameFile])).toEqual([
      ["mbank-a2.csv", 1, true],
    ]);

    // a cashU format document: the newest-day rule marks rows covered by stored history as overlap
    const doc = t.shown("doc.json", { importer: "auto" });
    expect(doc.importer).toEqual({ id: "cashu-budget", detected: true });
    expect(doc.account).toMatchObject({ existing: true, transactions: 5, name: "mBank 0001" });
    expect(doc.counts).toEqual({ rows: 3, new: 1, duplicates: 2, overlap: 2, skipped: 0 });
    expect(doc.rows.map((r) => [r.status, r.overlap, r.title])).toEqual([
      ["duplicate", true, "SKLEP TEST"],
      ["duplicate", true, null],
      ["new", false, null],
    ]);
    expect(doc.warnings.map((w) => w.kind)).toEqual(["overlap"]);
    expect(t.preview("doc-eur.json", { importer: "auto" })).toMatchObject({
      ok: false,
      code: "import_currency_mismatch",
    });

    // the Konto select lists both bank accounts
    const accounts = budgetDesktopQueries().statementAccounts.run(t.read, { lang: "pl" });
    expect(accounts.map((a) => [a.bankName, a.name, a.ibanTail, a.currency])).toEqual([
      ["mBank", "mBank 0001", "0001", "PLN"],
      ["Bank Pekao", "Oszczędności", "0002", "PLN"],
    ]);

    // Dopasuj: nothing left to pair (Python 0), after a reset the one pair (Python 1)
    const m1 = run(t.store, t.env, matchDesktopTransfers, {});
    expect(m1.ok && m1.value).toEqual({ pairs: 0 });
    const reset = run(t.store, t.env, matchTransfersCommand, { reset: true });
    expect(reset.ok && reset.value).toEqual({ cleared: 2, matched: 1 });
    expect(transferPairCount(t.read)).toBe(1);
  });

  it("refuses a commit whose bytes no longer hash to the preview", () => {
    const t = setup();
    const req = request("mbank-a.csv");
    const out = run(t.store, t.env, commitStatementImport, {
      fileName: req.fileName,
      content: req.content,
      sha256: "0".repeat(64),
      lang: "pl",
    });
    expect(out).toMatchObject({ ok: false, reason: "staged_file_changed" });
  });
});
