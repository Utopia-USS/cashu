// The import service: preview notes, the staged upload, the archive before the one-batch commit,
// re-resolution, duplicates, corporate actions, reconciliation corrections, generic CSV mappings.
// Translates tests/investments/persistence/test_invp_imports.py test-for-test (store level: the
// archive and the holding area are in-memory fakes of the ports; "atomic" = one appended batch).
// Plus the S22b additions: a manual entry imported later is a duplicate (Python stores manual rows
// under the import hash), the merged-away instrument gids reach the dedup, leader-only commits.
// Synthetic data only.
import { D, sha256Hex } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { type EventWriter, storeWriter } from "../../command.js";
import type { Envelope } from "../../events/v1/envelope.js";
import { addBrokerageAccount } from "../commands/accounts.js";
import { applyReconciliation } from "../commands/imports.js";
import { createInstrument } from "../commands/instruments.js";
import { addManualTransaction } from "../commands/manual.js";
import { mergeInstruments } from "../commands/merge.js";
import { createPlannedDeposit } from "../commands/planned.js";
import { otherVault, type Vault, vault } from "../commands/testing/fixtures.js";
import {
  formerInstrumentGids,
  importBatches,
  previewImport,
  storedReconciliation,
} from "../queries/import-preview.js";
import { allInstruments, loadInstrument } from "../queries/instruments.js";
import { plannedDeposits } from "../queries/planned.js";
import {
  accountSettings,
  latestPositionSnapshot,
  manualValuations,
  renames,
  transactions,
} from "../queries/transactions.js";
import {
  type BlobRef,
  type CommitRequest,
  commitStaged,
  type ImportArchive,
  type ImportStaging,
  previewAndStage,
} from "./imports.js";

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price," +
  "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source";
const ROWS = [
  "1,txn,2026-01-05,09:00,deposit,T-1,,,,,,,PLN,,,,20000.00,,,,examplebroker",
  "1,txn,2026-01-07,09:15,buy,T-2,ABC,PLABC0000016,ABC Example SA,XWAR,100,50.00,PLN,5000.00,5.00,,-5005.00,,,,",
  "1,txn,2026-01-12,10:30,buy,T-3,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,100.00,EUR,1000.00,,,-4300.00,PLN,4.3,,",
  "1,txn,2026-01-14,16:00,buy,T-4,XMPL,US0000000001,Example Corp,XNAS,20,100.00,USD,2000.00,,,-8000.00,PLN,4.0,,",
  "1,txn,2026-01-25,,dividend,T-5,XMPL,US0000000001,Example Corp,XNAS,,,USD,10.00,,1.50,8.50,,,,",
];
const positionRows = (xmpl = 20, asOf = "2026-02-27") => [
  `1,position,${asOf},,,,ABC,PLABC0000016,ABC Example SA,XWAR,100,,PLN,,,,,,,,`,
  `1,position,${asOf},,,,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,10,,EUR,,,,,,,,`,
  `1,position,${asOf},,,,XMPL,US0000000001,Example Corp,XNAS,${xmpl},,USD,,,,,,,,`,
];
const text = (lines: readonly string[]) => new TextEncoder().encode(`${lines.join("\n")}\n`);
function canonicalCsv(
  options: { positions?: boolean; xmpl?: number; extra?: string[] } = {},
): Uint8Array {
  return text([
    HEADER,
    ...ROWS,
    ...(options.extra ?? []),
    ...(options.positions === false ? [] : positionRows(options.xmpl)),
  ]);
}

const GENERIC = `version: 1
name: "Synthetic broker"
broker_id: genbroker
encoding: utf-8
delimiter: ","
decimal_separator: "."
date_formats: ["yyyy-MM-dd"]
default_currency: PLN
amount_sign: signed
columns:
  trade_date: "date"
  type: "type"
  symbol: "symbol"
  exchange: "exchange"
  quantity: "qty"
  price: "price"
  currency: "ccy"
  cash_amount: "cash"
types:
  "BUY": buy
  "DEP": deposit
`;
const GENERIC_FILE = new TextEncoder().encode(
  "date,type,symbol,exchange,qty,price,ccy,cash\n2026-01-05,DEP,,,,,PLN,1000\n2026-01-06,BUY,ABC,XWAR,2,50,PLN,-100\n",
);

/** In-memory ports: the encrypted archive (by plaintext sha256) and the holding area. */
function ports() {
  const archived = new Map<string, Uint8Array>();
  const staged = new Map<string, Uint8Array>();
  const archive: ImportArchive = {
    put: async (content, ext): Promise<BlobRef> => {
      const sha256 = sha256Hex(content);
      archived.set(`${sha256}.${ext}`, content);
      return { sha256, ext };
    },
  };
  const staging: ImportStaging = {
    put: async (sha, ext, content) => {
      staged.set(`${sha}.${ext}`, content);
    },
    get: async (sha, ext) => staged.get(`${sha}.${ext}`) ?? null,
    remove: async (sha, ext) => {
      staged.delete(`${sha}.${ext}`);
    },
  };
  return { archived, staged, archive, staging };
}

interface Setup {
  readonly v: Vault;
  readonly account: string;
  readonly p: ReturnType<typeof ports>;
  /** Every batch the service appended. */
  readonly batches: Envelope[][];
  readonly writer: EventWriter;
}

function setup(): Setup {
  const v = vault();
  const account = v.value(addBrokerageAccount, { name: "Konto DIF", broker: "dif" }).account;
  const batches: Envelope[][] = [];
  const inner = storeWriter(v.store);
  const writer: EventWriter = {
    append(envelopes) {
      batches.push([...envelopes]);
      inner.append(envelopes);
    },
  };
  return { v, account, p: ports(), batches, writer };
}

const read = (v: Vault) => v.store.read.bind(v.store);
const now = (v: Vault) => new Date(v.env.clock.now()).toISOString();

function preview(s: Setup, content: Uint8Array, name = "history.csv", extra: object = {}) {
  const out = previewImport(
    read(s.v),
    { file: { name, content }, account: s.account, ...extra },
    now(s.v),
  );
  if (!out.ok) throw new Error(`preview refused: ${out.reason}`);
  return out.preview;
}

/** Python `import_file`: preview (staging the upload), then commit the staged file. */
async function importFile(
  s: Setup,
  content: Uint8Array,
  name = "history.csv",
  extra: Partial<CommitRequest> = {},
) {
  const staged = await previewAndStage(
    { store: s.v.store, staging: s.p.staging, env: s.v.env },
    { file: { name, content }, account: s.account, ...extra },
  );
  if (!staged.ok) throw new Error(`preview refused: ${staged.reason}`);
  const out = await commitStaged(
    {
      store: s.v.store,
      staging: s.p.staging,
      archive: s.p.archive,
      writer: s.writer,
      env: s.v.env,
    },
    { fileId: staged.fileId, fileName: name, account: s.account, ...extra },
  );
  if (!out.ok) throw new Error(`commit refused: ${out.reason}`);
  s.v.env.advance(1000);
  return out.result;
}

const counts = (v: Vault) => ({
  txns: transactions(read(v)).length,
  instruments: allInstruments(read(v)).length,
  batches: importBatches(read(v)).length,
});

describe("import service (test_invp_imports.py)", () => {
  it("test_preview_is_read_only_and_reports_the_plan", async () => {
    const s = setup();
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "history.csv", content: canonicalCsv() }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    const p = staged.preview;
    expect(p.canCommit).toBe(true);
    expect(p.importerId).toBe("cashu");
    const plan = p.plan;
    expect(plan?.rows.filter((r) => !r.isDuplicate)).toHaveLength(5);
    expect(plan?.rows.filter((r) => r.isDuplicate)).toHaveLength(0);
    expect(plan?.positions).toHaveLength(3);
    expect(plan?.newInstruments.map((i) => i.symbol)).toEqual(["ABC", "WRLD", "XMPL"]);
    expect(p.notes.some((n) => n.message.includes("source 'examplebroker'"))).toBe(true);
    expect(p.reconciliation?.corrections).toEqual([]);
    expect(counts(s.v)).toEqual({ txns: 0, instruments: 0, batches: 0 });
    expect(s.batches).toEqual([]);
    expect([...s.p.staged.keys()]).toEqual([`${staged.fileId}.csv`]);
  });

  it("test_commit_archives_then_writes_everything", async () => {
    const s = setup();
    const result = await importFile(s, canonicalCsv());
    expect([result.inserted, result.duplicates, result.positions]).toEqual([5, 0, 3]);
    expect(result.newInstruments).toHaveLength(3);
    const sha = sha256Hex(canonicalCsv());
    expect(result.archive).toBe(`${sha}.csv`);
    expect(s.p.archived.get(`${sha}.csv`)).toEqual(canonicalCsv());
    expect(s.p.staged.size).toBe(0); // the staged copy goes once committed
    expect(s.batches).toHaveLength(1); // one batch
    const rows = transactions(read(s.v)).sort((a, b) =>
      a.createdAt.date === b.createdAt.date ? a.createdAt.microsecond - b.createdAt.microsecond : 0,
    );
    expect(rows.map((r) => r.externalRef).sort()).toEqual(["T-1", "T-2", "T-3", "T-4", "T-5"]);
    expect(new Set(rows.map((r) => JSON.stringify(r.createdAt))).size).toBe(5);
    expect(rows.every((r) => r.importBatchId === result.batch)).toBe(true);
    const wrld = rows.find((r) => r.externalRef === "T-3");
    expect(wrld?.cashAmount.eq(D("-4300.00"))).toBe(true);
    expect(wrld?.fxRate?.eq(D("4.3"))).toBe(true);
    const [batch] = importBatches(read(s.v));
    expect([batch?.importer, batch?.txnCount, batch?.positionCount, batch?.archive]).toEqual([
      "cashu",
      5,
      3,
      `${sha}.csv`,
    ]);
    expect(latestPositionSnapshot(read(s.v), s.account).rows).toHaveLength(3);
    const xmpl = allInstruments(read(s.v)).find((i) => i.symbol === "XMPL");
    expect([xmpl?.currency, xmpl?.mic, xmpl?.needsClassification]).toEqual(["USD", "XNAS", true]);
    expect(
      xmpl?.aliases.some((a) => a.namespace === "yahoo" && a.value === "XMPL" && a.guessed),
    ).toBe(true);
    expect(accountSettings(read(s.v), s.account).importer).toBe("cashu");
  });

  it("test_reimport_is_all_duplicates_and_says_so", async () => {
    const s = setup();
    await importFile(s, canonicalCsv());
    const p = preview(s, canonicalCsv());
    expect(p.plan?.rows.filter((r) => r.isDuplicate)).toHaveLength(5);
    expect(p.notes.some((n) => n.message.includes("already imported"))).toBe(true);
    const again = await importFile(s, canonicalCsv());
    expect([again.inserted, again.duplicates, again.newInstruments]).toEqual([0, 5, []]);
    expect(counts(s.v)).toMatchObject({ txns: 5, instruments: 3 });
  });

  it("test_commit_is_atomic", async () => {
    const s = setup();
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "history.csv", content: canonicalCsv() }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    const broken: EventWriter = {
      append() {
        throw new Error("disk full");
      },
    };
    await expect(
      commitStaged(
        {
          store: s.v.store,
          staging: s.p.staging,
          archive: s.p.archive,
          writer: broken,
          env: s.v.env,
        },
        { fileId: staged.fileId, fileName: "history.csv", account: s.account },
      ),
    ).rejects.toThrow("disk full");
    expect(counts(s.v)).toEqual({ txns: 0, instruments: 0, batches: 0 });
    expect(s.p.staged.size).toBe(1); // kept for a retry (pruned after a day)
  });

  it("test_commit_reuses_an_instrument_created_after_the_preview", async () => {
    const s = setup();
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "history.csv", content: canonicalCsv() }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    const stored = s.v.value(createInstrument, {
      name: "Example Corp",
      currency: "USD",
      assetClass: "equity",
      symbol: "XMPL",
      isin: "US0000000001",
      mic: "XNAS",
    }).gid;
    const out = await commitStaged(
      {
        store: s.v.store,
        staging: s.p.staging,
        archive: s.p.archive,
        writer: s.writer,
        env: s.v.env,
      },
      { fileId: staged.fileId, fileName: "history.csv", account: s.account },
    );
    if (!out.ok) throw new Error(out.reason);
    expect(out.result.newInstruments).not.toContain(stored);
    expect(out.result.newInstruments).toHaveLength(2);
    expect(allInstruments(read(s.v)).filter((i) => i.isin === "US0000000001")).toHaveLength(1);
    const refs = transactions(read(s.v))
      .filter((t) => t.instrumentId === stored)
      .map((t) => t.externalRef)
      .sort();
    expect(refs).toEqual(["T-4", "T-5"]);
    expect(preview(s, canonicalCsv()).plan?.rows.filter((r) => r.isDuplicate)).toHaveLength(5);
  });

  it("test_rename_and_frozen_delisting", async () => {
    const s = setup();
    const header = `${HEADER},new_symbol,new_isin,new_name,frozen`;
    const content = text([
      header,
      ...ROWS.map((r) => `${r},,,,`),
      "1,rename,2026-02-15,,,,ABC,PLABC0000016,,XWAR,,,,,,,,,,,,ABCN,PLABCN000012,ABC New SA,",
      "1,delisting,2026-02-20,,,,XMPL,US0000000001,,XNAS,,,,,,,,,,,,,,,true",
    ]);
    const p = preview(s, content);
    expect(p.canCommit, JSON.stringify(p.errors)).toBe(true);
    const result = await importFile(s, content);
    expect([result.renames, result.statusChanges]).toEqual([1, 1]);
    const [rename] = renames(read(s.v));
    expect(loadInstrument(read(s.v), String(rename?.newInstrumentId))?.symbol).toBe("ABCN");
    const xmpl = allInstruments(read(s.v)).find((i) => i.symbol === "XMPL");
    if (xmpl === undefined) throw new Error("XMPL stored");
    // the delisting is this vault's view; the shared row keeps its market status (F5 R2)
    expect(loadInstrument(read(s.v), xmpl.id, { shared: true })?.status).toBe("active");
    expect(loadInstrument(read(s.v), xmpl.id)?.status).toBe("frozen");
    const [mv] = manualValuations(read(s.v));
    expect([mv?.instrumentId, mv?.unitValue.isZero(), mv?.currency]).toEqual([
      xmpl.id,
      true,
      "USD",
    ]);
    expect((await importFile(s, content)).renames).toBe(0);
  });

  it("test_reconciliation_corrections_apply_once", async () => {
    const s = setup();
    const p = preview(s, canonicalCsv({ xmpl: 25 }));
    const mismatches = p.reconciliation?.diffs.filter((d) => d.kind !== "match") ?? [];
    expect(mismatches).toHaveLength(1);
    const [diff] = mismatches;
    expect(diff?.brokerQuantity.sub(diff.computedQuantity).eq(D("5"))).toBe(true);
    const result = await importFile(s, canonicalCsv({ xmpl: 25 }), "history.csv", {
      corrections: [String(diff?.instrumentId)],
    });
    expect(result.corrections).toBe(1);
    const fixes = transactions(read(s.v)).filter((t) => t.source === "reconciliation");
    expect(fixes.map((f) => [f.type, f.quantity?.toString()])).toEqual([["adjustment", "5"]]);
    expect(storedReconciliation(read(s.v), s.account, now(s.v))?.corrections).toEqual([]);
    const again = s.v.value(applyReconciliation, {
      account: s.account,
      instruments: [String(fixes[0]?.instrumentId)],
    });
    expect(again.applied).toBe(0);
  });

  it("test_apply_reconciliation_against_the_stored_snapshot", async () => {
    const s = setup();
    await importFile(s, canonicalCsv({ xmpl: 18 }));
    const report = storedReconciliation(read(s.v), s.account, now(s.v));
    const mismatches = report?.diffs.filter((d) => d.kind !== "match") ?? [];
    expect(mismatches).toHaveLength(1);
    const instrument = String(mismatches[0]?.instrumentId);
    expect(mismatches[0]?.brokerQuantity.sub(mismatches[0].computedQuantity).eq(D("-2"))).toBe(
      true,
    );
    expect(
      s.v.value(applyReconciliation, { account: s.account, instruments: [instrument] }),
    ).toEqual({
      applied: 1,
    });
    expect(
      s.v.value(applyReconciliation, { account: s.account, instruments: [instrument] }),
    ).toEqual({
      applied: 0,
    });
    expect(storedReconciliation(read(s.v), s.account, now(s.v))?.corrections).toEqual([]);
    const fixes = transactions(read(s.v)).filter((t) => t.source === "reconciliation");
    expect(fixes.map((f) => [f.type, f.quantity?.toString()])).toEqual([["transfer_out", "2"]]);
  });

  it("test_generic_csv_mapping_is_remembered", async () => {
    const s = setup();
    const extra = { importer: "generic_csv", mappingYaml: GENERIC };
    const p = preview(s, GENERIC_FILE, "gen.csv", extra);
    expect(p.canCommit, JSON.stringify(p.errors)).toBe(true);
    expect(p.importerId).toBe("genbroker");
    await importFile(s, GENERIC_FILE, "gen.csv", extra);
    const settings = accountSettings(read(s.v), s.account);
    expect([settings.importer, settings.mappingYaml]).toEqual(["genbroker", GENERIC]);
    // auto detection now finds the remembered mapping for this account
    const again = preview(s, GENERIC_FILE, "gen.csv");
    expect(again.importerId).toBe("genbroker");
    expect(again.plan?.rows.filter((r) => r.isDuplicate)).toHaveLength(2);
  });

  it("test_a_positions_only_file_keeps_the_remembered_importer", async () => {
    const s = setup();
    await importFile(s, GENERIC_FILE, "gen.csv", { importer: "generic_csv", mappingYaml: GENERIC });
    const snapshot = text([HEADER, ...positionRows().slice(0, 1)]);
    const p = preview(s, snapshot, "positions.csv");
    expect(p.importerId).toBe("cashu");
    expect(p.plan?.rows).toEqual([]);
    expect(p.plan?.positions.length).toBeGreaterThan(0);
    await importFile(s, snapshot, "positions.csv");
    const settings = accountSettings(read(s.v), s.account);
    expect([settings.importer, settings.mappingYaml]).toEqual(["genbroker", GENERIC]);
    await importFile(s, canonicalCsv({ positions: false }));
    expect(accountSettings(read(s.v), s.account).importer).toBe("cashu");
  });

  it("test_errors_are_reported_not_raised", async () => {
    const s = setup();
    const bad = new TextEncoder().encode("not,an,export\n1,2,3\n");
    const p = preview(s, bad, "x.csv");
    expect(p.canCommit).toBe(false);
    expect(p.errors[0]?.kind).toBe("file_format");
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "x.csv", content: bad }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    const out = await commitStaged(
      {
        store: s.v.store,
        staging: s.p.staging,
        archive: s.p.archive,
        writer: s.writer,
        env: s.v.env,
      },
      { fileId: staged.fileId, fileName: "x.csv", account: s.account },
    );
    expect(out).toEqual({ ok: false, reason: "cannot_commit" });
    const unresolvable = canonicalCsv({
      extra: ["1,txn,2026-01-08,,buy,T-7,,,,,1,10,PLN,10,,,-10,,,,"],
    });
    expect(preview(s, unresolvable).canCommit).toBe(false);
    const file = { name: "history.csv", content: canonicalCsv() };
    expect(previewImport(read(s.v), { file, account: "0".repeat(26) }, now(s.v))).toEqual({
      ok: false,
      reason: "no_account",
    });
    const other = otherVault();
    expect(previewImport(read(other), { file, account: s.account }, now(other))).toEqual({
      ok: false,
      reason: "no_account",
    }); // another vault's account
  });

  it("test_an_identical_overlapping_reimport_leaves_the_snapshots_alone", async () => {
    const s = setup();
    await importFile(s, canonicalCsv());
    const before = latestPositionSnapshot(read(s.v), s.account).rows;
    await importFile(s, canonicalCsv(), "history-2.csv");
    const snapshotEvents = (batch: Envelope[] | undefined) =>
      (batch ?? []).filter((e) => e.type === "position.snapshotImported");
    expect(snapshotEvents(s.batches[1])).toEqual([]); // the same figures: nothing written or synced
    expect(latestPositionSnapshot(read(s.v), s.account).rows).toEqual(before);
    await importFile(s, canonicalCsv({ xmpl: 25 }), "history-3.csv");
    // A changed figure of a held row is `position.snapshotUpdated` (the shipper emits the same for
    // Python's update, S31c) and the later import's figures stand in the view (Python updates them).
    const updates = (s.batches[2] ?? []).filter((e) => e.type === "position.snapshotUpdated");
    expect(updates.map((e) => e.data.quantity)).toEqual(["25"]);
    expect(snapshotEvents(s.batches[2])).toEqual([]);
    const after = latestPositionSnapshot(read(s.v), s.account).rows;
    expect(
      after.filter((r) => !before.some((b) => JSON.stringify(b) === JSON.stringify(r))),
    ).toEqual([expect.objectContaining({ quantity: "25" })]);
  });

  it("test_a_reimport_with_the_same_importer_leaves_the_account_settings_alone", async () => {
    const s = setup();
    await importFile(s, canonicalCsv());
    await importFile(s, canonicalCsv(), "history-2.csv");
    expect(s.batches[1]?.some((e) => e.type === "invAccount.settingsSet")).toBe(false);
  });
});

describe("import service (S22b)", () => {
  it("a manual entry imported later is a duplicate, a second identical file row still imports", async () => {
    const s = setup();
    s.v.value(addManualTransaction, {
      account: s.account,
      type: "deposit",
      tradeDate: "2026-01-05",
      cashAmount: "20000.00",
      currency: "PLN",
    });
    const deposit = text([HEADER, "1,txn,2026-01-05,,deposit,,,,,,,,PLN,,,,20000.00,,,,"]);
    expect(preview(s, deposit).plan?.rows.map((r) => r.isDuplicate)).toEqual([true]);
    const twice = text([
      HEADER,
      "1,txn,2026-01-05,,deposit,,,,,,,,PLN,,,,20000.00,,,,",
      "1,txn,2026-01-05,,deposit,,,,,,,,PLN,,,,20000.00,,,,",
    ]);
    expect(preview(s, twice).plan?.rows.map((r) => r.isDuplicate)).toEqual([true, false]);
  });

  it("the same trades through another importer are duplicates (content rows carry no broker)", async () => {
    const s = setup();
    const canonical = text([
      HEADER,
      "1,txn,2026-01-05,,deposit,,,,,,,,PLN,,,,1000,,,,examplebroker",
      "1,txn,2026-01-06,,buy,,ABC,,,XWAR,2,50,PLN,100,,,-100,,,,examplebroker",
    ]);
    await importFile(s, canonical);
    const again = preview(s, GENERIC_FILE, "gen.csv", {
      importer: "generic_csv",
      mappingYaml: GENERIC,
    });
    expect(again.plan?.rows.map((r) => r.isDuplicate)).toEqual([true, true]);
  });

  it("two position lines of one file for the same instrument and date: the last one wins", async () => {
    const s = setup();
    await importFile(
      s,
      text([HEADER, ...ROWS, ...positionRows(20).slice(2), ...positionRows(25).slice(2)]),
    );
    const rows = latestPositionSnapshot(read(s.v), s.account).rows;
    expect(rows.map((r) => r.quantity)).toEqual(["25"]);
    expect(s.p.archived.size).toBe(1);
  });

  it("an import refused at commit archives nothing", async () => {
    const s = setup();
    const bad = new TextEncoder().encode("not,an,export\n1,2,3\n");
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "x.csv", content: bad }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    const deps = {
      store: s.v.store,
      staging: s.p.staging,
      archive: s.p.archive,
      writer: s.writer,
      env: s.v.env,
    };
    expect(
      await commitStaged(deps, { fileId: staged.fileId, fileName: "x.csv", account: s.account }),
    ).toEqual({
      ok: false,
      reason: "cannot_commit",
    });
    expect(s.p.archived.size).toBe(0);
  });

  it("the merge record supplies the merged-away instrument gids to the dedup", async () => {
    const s = setup();
    const a = s.v.value(createInstrument, {
      name: "A",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "xtb", value: "AAA" }],
    }).gid;
    const b = s.v.value(createInstrument, {
      name: "B",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "xtb", value: "BBB" }],
    }).gid;
    expect(formerInstrumentGids(read(s.v), b)).toEqual([]);
    s.v.value(mergeInstruments, { source: a, target: b });
    expect(formerInstrumentGids(read(s.v), b)).toEqual([a]);
    expect(formerInstrumentGids(read(s.v), a)).toEqual([a]); // asked by the old gid: the root's
  });

  it("books a planned deposit the file's deposit matches, in the commit's batch", async () => {
    const s = setup();
    const plan = s.v.value(createPlannedDeposit, {
      amount: "1000",
      plannedDate: "2026-10-31",
      account: s.account,
    });
    const file = text([HEADER, "1,txn,2026-10-30,,deposit,D-1,,,,,,,PLN,,,,1000.00,,,,"]);
    const result = await importFile(s, file);
    expect(result.plannedBooked).toEqual([plan.plan]);
    expect(plannedDeposits(read(s.v), ["booked"]).map((p) => p.gid)).toEqual([plan.plan]);
    expect(s.batches[0]?.some((e) => e.type === "plannedDeposit.booked")).toBe(true);
  });

  it("a device that does not hold the fetch lease refuses the commit", async () => {
    const s = setup();
    const staged = await previewAndStage(
      { store: s.v.store, staging: s.p.staging, env: s.v.env },
      { file: { name: "history.csv", content: canonicalCsv() }, account: s.account },
    );
    if (!staged.ok) throw new Error(staged.reason);
    s.v.env.holder = false;
    const out = await commitStaged(
      {
        store: s.v.store,
        staging: s.p.staging,
        archive: s.p.archive,
        writer: s.writer,
        env: s.v.env,
      },
      { fileId: staged.fileId, fileName: "history.csv", account: s.account },
    );
    expect(out).toEqual({ ok: false, reason: "not_leader" });
    expect(s.p.archived.size).toBe(0);
  });

  it("a commit names a staged file by its sha256 only", async () => {
    const s = setup();
    const deps = {
      store: s.v.store,
      staging: s.p.staging,
      archive: s.p.archive,
      writer: s.writer,
      env: s.v.env,
    };
    expect(
      await commitStaged(deps, { fileId: "../x", fileName: "a.csv", account: s.account }),
    ).toEqual({
      ok: false,
      reason: "invalid_file_id",
    });
    expect(
      await commitStaged(deps, { fileId: "a".repeat(64), fileName: "a.csv", account: s.account }),
    ).toEqual({ ok: false, reason: "no_staged_file" });
  });
});
