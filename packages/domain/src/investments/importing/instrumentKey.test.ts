import { describe, expect, it } from "vitest";
import {
  AssetClass,
  asAccountId,
  asInstrumentId,
  asTxnId,
  Currencies,
  type Instrument,
  type InstrumentAlias,
  instrument,
  instrumentAlias,
} from "../domain/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import { effectiveBrokerId } from "./contract.js";
import {
  candidateInstrumentKeys,
  instrumentKeyV2,
  reconciliationInstrumentKey,
} from "./instrumentKey.js";
import { type ImportPlan, planImport } from "./plan.js";
import { InMemoryInstrumentLookup } from "./resolver.js";
import { enc } from "./testing/support.js";

const alias = (namespace: string, value: string, guessed = false) =>
  instrumentAlias(namespace, value, guessed);
const noGid = () => {
  throw new Error("the gid step must not be reached");
};
const key = (aliases: InstrumentAlias[], broker: string | null, isin: string | null = null) =>
  instrumentKeyV2({ aliases, isin }, broker, noGid);

describe("instrumentKeyV2 (gid.md 7.2 over the resolved instrument)", () => {
  it("takes the broker alias, then the isin alias, then the ISIN column, then the gid", () => {
    const all = [
      alias("isin", "XX0000000001"),
      alias("xtb", "TST"),
      alias("yahoo", "TST.WA", true),
    ];
    expect(key(all, "xtb", "XX0000000009")).toBe("xtb:TST");
    expect(key(all, "dif", "XX0000000009")).toBe("isin:XX0000000001");
    expect(key([alias("xtb", "TST")], "dif", "XX0000000009")).toBe("isin:XX0000000009");
    expect(instrumentKeyV2({ aliases: [alias("xtb", "TST")], isin: null }, "dif", () => "G1")).toBe(
      "gid:G1",
    );
    expect(reconciliationInstrumentKey("G1")).toBe("gid:G1");
  });

  it("an ISIN-only row of a broker-aliased instrument gets the broker alias, not its ISIN", () => {
    // the key never reads the row: whatever hint resolved the instrument, the key is the same
    const aliases = [alias("examplebroker", "ABC"), alias("stooq", "abc", true)];
    expect(key(aliases, "examplebroker", "XX0000000001")).toBe("examplebroker:ABC");
  });

  it("a row without a batch starts at the ISIN steps", () => {
    expect(key([alias("xtb", "TST")], null, "XX0000000009")).toBe("isin:XX0000000009");
  });

  // legacy name: a batch or alias under the pre-rename namespace is the canonical one
  it("reads the legacy namespace as the canonical one, under the canonical name", () => {
    const legacy = [alias("finanse", "OLD")];
    expect(key(legacy, "finanse")).toBe("cashu:OLD");
    expect(key(legacy, "cashu")).toBe("cashu:OLD");
    // legacy name: a batch stored under the pre-rename broker id
    expect(key([alias("cashu", "NEW")], "finanse")).toBe("cashu:NEW");
  });

  it("ranks the legacy alias first, then confirmed before guessed, then the oldest", () => {
    // legacy name: domain order (namespace, guessed, id) puts cashu before finanse, though the
    // legacy alias is the older one
    const domainOrder = [alias("cashu", "NEW"), alias("finanse", "OLD")];
    // legacy name: the same aliases by ascending id (genesis reads the stored rows)
    const idOrder = [alias("finanse", "OLD"), alias("cashu", "NEW")];
    expect(key(domainOrder, "cashu")).toBe("cashu:OLD");
    expect(key(idOrder, "cashu")).toBe("cashu:OLD");
    expect(key([alias("xtb", "A"), alias("xtb", "B")], "xtb")).toBe("xtb:A");
    expect(key([alias("xtb", "G", true), alias("xtb", "C")], "xtb")).toBe("xtb:C");
    expect(key([alias("isin", "XX0000000002", true), alias("isin", "XX0000000001")], null)).toBe(
      "isin:XX0000000001",
    );
  });
});

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price," +
  "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,note,source";
const file = (name: string, rows: string[]) => ({
  name,
  content: enc(`${[HEADER, ...rows].join("\n")}\n`),
});
const ACCOUNT = "acct-gid";

function plan(f: ReturnType<typeof file>, lookup: InMemoryInstrumentLookup, stored: Set<string>) {
  const importer = new CanonicalImporter();
  const parsed = importer.parse(f);
  let n = 0;
  return planImport(parsed, {
    accountId: asAccountId("1"),
    brokerId: effectiveBrokerId(importer, parsed),
    lookup,
    existingHashes: (hashes) => hashes.filter((h) => stored.has(h)),
    instrumentIdFactory: () => asInstrumentId(`p-${f.name}-${++n}`),
    txnIdFactory: () => asTxnId(`t-${++n}`),
    dedupV2: { accountGid: ACCOUNT, instrumentGid: (id) => `gid-${id}` },
  });
}

/** What a store commit leaves: new instruments with their aliases, learned aliases appended, hashes. */
function commit(p: ImportPlan, instruments: Map<string, Instrument>, stored: Set<string>) {
  for (const item of p.newInstruments) instruments.set(item.id, item);
  for (const [id, added] of p.newAliases) {
    const current = instruments.get(id);
    if (current !== undefined) {
      instruments.set(id, { ...current, aliases: [...current.aliases, ...added] });
    }
  }
  for (const row of p.rows) stored.add(row.txn.dedupHash);
}

describe("planImport with dedupV2", () => {
  const fileA = file("a.csv", [
    "1,txn,2026-01-07,,buy,O-1,,XX0000000001,,,10,50,PLN,500,,,-500,,,,examplebroker",
    "1,txn,2026-01-08,,buy,,ABC,XX0000000001,,XWAR,1,51,PLN,51,,,-51,,,,examplebroker",
    "1,txn,2026-01-09,,fee,,,,,,,,PLN,,,,-5,,,,examplebroker",
    "1,txn,2026-01-09,,fee,,,,,,,,PLN,,,,-5,,,,examplebroker",
  ]);

  it("keys every row of a file by the instrument as the commit leaves it", () => {
    const p = plan(fileA, new InMemoryInstrumentLookup(), new Set());
    // the ISIN-only first row and the symbol row share the alias the file teaches
    const [first, second] = p.rows;
    expect(first?.txn.instrumentId).toBe(second?.txn.instrumentId);
    const replanned = plan(fileA, new InMemoryInstrumentLookup(), new Set());
    expect(replanned.rows.map((r) => r.txn.dedupHash)).toEqual(p.rows.map((r) => r.txn.dedupHash));
    expect(new Set(p.rows.map((r) => r.txn.dedupHash)).size).toBe(4);
  });

  it("a TS re-import of files the TS store committed is all duplicates", () => {
    const instruments = new Map<string, Instrument>([
      [
        "1",
        instrument({
          id: asInstrumentId("1"),
          name: "Stored",
          currency: Currencies.PLN,
          assetClass: AssetClass.EQUITY,
          isin: "XX0000000001",
          aliases: [alias("examplebroker", "OLDABC")],
        }),
      ],
    ]);
    const stored = new Set<string>();
    const fileB = file("b.csv", [
      "1,txn,2026-01-20,,sell,S-1,ABC,,,,1,60,PLN,60,,,60,,,,examplebroker",
    ]);
    for (const f of [fileA, fileB]) {
      const p = plan(f, new InMemoryInstrumentLookup(instruments.values()), stored);
      expect(p.rows.every((r) => !r.isDuplicate)).toBe(true);
      commit(p, instruments, stored);
    }
    expect(instruments.get("1")?.aliases.map((a) => a.value)).toEqual(["OLDABC", "ABC"]);
    for (const f of [fileA, fileB]) {
      const again = plan(f, new InMemoryInstrumentLookup(instruments.values()), stored);
      expect(again.rows.every((r) => r.isDuplicate)).toBe(true);
    }
  });
});

describe("candidateInstrumentKeys", () => {
  const free = () => true;
  it("lists every key the instrument may have been stored under, the stored key first", () => {
    const keys = candidateInstrumentKeys({
      subject: {
        // legacy name: an alias stored under the pre-rename namespace
        aliases: [alias("finanse", "OLD"), alias("cashu", "NEW"), alias("isin", "XX0000000001")],
        isin: "XX0000000002",
        symbol: "TCK",
      },
      brokerId: "cashu",
      gid: "G1",
      rowSymbol: "ROW",
      rowIsin: "XX0000000003",
      free,
    });
    expect(keys).toEqual([
      "cashu:OLD",
      // legacy name: the pre-S17d genesis prefix
      "finanse:OLD",
      "cashu:NEW",
      "isin:XX0000000001",
      "isin:XX0000000002",
      "cashu:TCK",
      "cashu:ROW",
      "isin:XX0000000003",
      "gid:G1",
    ]);
  });

  it("adds the gids merged into the instrument as gid keys (the store's merge record)", () => {
    const keys = candidateInstrumentKeys({
      subject: { aliases: [], isin: null, symbol: null },
      brokerId: "xtb",
      gid: "G1",
      formerGids: ["G0", "G1", "G2"],
      rowSymbol: null,
      rowIsin: null,
      free,
    });
    expect(keys).toEqual(["gid:G1", "gid:G0", "gid:G2"]);
  });

  it("keeps a ticker or row hint another instrument owns out of the candidates", () => {
    const keys = candidateInstrumentKeys({
      subject: { aliases: [alias("xtb", "S")], isin: null, symbol: "PKN" },
      brokerId: "xtb",
      gid: "G1",
      rowSymbol: "OTHER",
      rowIsin: "XX0000000003",
      free: (_, value) => value !== "PKN" && value !== "XX0000000003",
    });
    expect(keys).toEqual(["xtb:S", "xtb:OTHER", "gid:G1"]);
  });
});

describe("planImport with dedupV2: a re-import never duplicates, whatever the alias history", () => {
  const BROKER = "examplebroker";
  const isinOnly = (extra = "") =>
    `1,txn,2026-03-02,,buy,,,XX0000000001,,,2,10,PLN,20,,,-20,,,${extra},${BROKER}`;

  function store() {
    const instruments = new Map<string, Instrument>();
    const stored = new Set<string>();
    const run = (f: ReturnType<typeof file>, write = true) => {
      const p = plan(f, new InMemoryInstrumentLookup(instruments.values()), stored);
      if (write) commit(p, instruments, stored);
      return p;
    };
    return { instruments, stored, run };
  }

  it("recognizes a row stored before its instrument learned a broker alias", () => {
    const s = store();
    const fileA = file("a.csv", [
      isinOnly(),
      "1,txn,2026-03-02,,fee,,,,,,,,PLN,,,,-1,,,,examplebroker",
    ]);
    const first = s.run(fileA);
    expect(first.rows.map((r) => r.isDuplicate)).toEqual([false, false]);
    // a later file names the instrument by its broker symbol: it learns examplebroker:NEWSYM
    s.run(
      file("b.csv", [
        `1,txn,2026-03-05,,buy,B-1,NEWSYM,XX0000000001,,,1,11,PLN,11,,,-11,,,,${BROKER}`,
      ]),
    );
    const again = s.run(fileA, false);
    // the ISIN-only row is now keyed by the broker alias, which is not the key it was stored under
    expect(s.stored.has(again.rows[0]?.txn.dedupHash ?? "")).toBe(false);
    expect(again.rows[0]?.txn.dedupHash).not.toBe(first.rows[0]?.txn.dedupHash);
    expect(again.rows.map((r) => r.isDuplicate)).toEqual([true, true]);
  });

  it("still imports a second identical trade the stored file did not have", () => {
    const s = store();
    s.run(file("a.csv", [isinOnly()]));
    s.run(
      file("b.csv", [
        `1,txn,2026-03-05,,buy,B-1,NEWSYM,XX0000000001,,,1,11,PLN,11,,,-11,,,,${BROKER}`,
      ]),
    );
    const twice = s.run(file("a2.csv", [isinOnly(), isinOnly()]), false);
    expect(twice.rows.map((r) => r.isDuplicate)).toEqual([true, false]);
  });

  it("never matches another instrument's row through a shared display ticker", () => {
    const s = store();
    const make = (id: string, symbol: string, isin: string | null, aliases: InstrumentAlias[]) =>
      instrument({
        id: asInstrumentId(id),
        name: id,
        currency: Currencies.PLN,
        assetClass: AssetClass.EQUITY,
        symbol,
        isin,
        aliases,
      });
    s.instruments.set("1", make("1", "PKN", "XX0000000001", [alias(BROKER, "S")]));
    s.instruments.set("2", make("2", "PKN", null, [alias(BROKER, "PKN")]));
    const same = (hint: string) =>
      `1,txn,2026-03-02,,buy,,${hint},,,2,10,PLN,20,,,-20,,,,${BROKER}`;
    // instrument 2 (broker symbol PKN), then the same content for instrument 1 by its ISIN
    s.run(file("j.csv", [same("PKN,")]));
    const other = s.run(file("i.csv", [same(",XX0000000001")]), false);
    expect(other.rows[0]?.txn.instrumentId).toBe("1");
    expect(other.rows[0]?.isDuplicate).toBe(false);
  });
});
