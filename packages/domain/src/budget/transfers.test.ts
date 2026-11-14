// Internal-transfer matching (transfers.py). Translates test_internal_transfer_matching
// (tests/test_ingestion.py) and test_own_ibans_are_per_profile (tests/test_profiles.py), then pins the
// rule-5 guard (IBAN only), the tie-breaks (Q2 / Q3), the amount keys (Q4 / Q5), and properties the
// store's incremental deriver relies on (S24b). Synthetic data only.

import { describe, expect, it } from "vitest";
import { ownIbans } from "../core/accounts.js";
import { addDays, daysBetween } from "../dates.js";
import { D } from "../decimal.js";
import {
  matchTransfers,
  pairScore,
  type TransferPair,
  type TransferRow,
  transferAccountKeys,
  transferAmountKey,
} from "./transfers.js";

const A_IBAN = "PL10000000000000000000000005";
const B_IBAN = "PL10000000000000000000000006";
const C_IBAN = "PL10000000000000000000000007"; // a third party
const DAY = "2024-02-01";

const accounts = transferAccountKeys([
  { key: "a", iban: A_IBAN },
  { key: "b", iban: B_IBAN },
]);

function row(
  key: string,
  account: string,
  amount: string,
  counterpartyIban: string | null = null,
  bookingDate = DAY,
): TransferRow {
  return { key, account, bookingDate, amount: D(amount), counterpartyIban };
}

const pairs = (ps: TransferPair[]) => ps.map((p) => [p.out, p.in]);

/** Deterministic PRNG (mulberry32): tests never use Math.random. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("matchTransfers: the Python oracle tests", () => {
  // test_internal_transfer_matching (tests/test_ingestion.py); its cashflow half is S10's.
  it("pairs an mBank outflow with the Erste inflow a day later by the counterparty IBANs", () => {
    const out = row("1", "a", "-1000.00", B_IBAN, "2024-02-01");
    const inc = row("2", "b", "1000.00", A_IBAN, "2024-02-02");
    expect(pairs(matchTransfers([out, inc], accounts))).toEqual([["1", "2"]]);
  });

  // test_own_ibans_are_per_profile (tests/test_profiles.py): the caller passes one profile's
  // accounts and rows, so a transfer to a partner's account in another profile stays an outflow.
  it("a transfer to another profile's account is not internal", () => {
    const jan = transferAccountKeys([{ key: "jan", iban: "99114000000000000000000101" }]);
    const out = row("1", "jan", "-500.00", "99109000000000000000000202", "2026-09-01");
    expect(matchTransfers([out], jan)).toEqual([]);
    const janOwn = ownIbans([{ iban: "99114000000000000000000101" }]);
    const olaOwn = ownIbans([{ iban: "99109000000000000000000202" }]);
    expect([...janOwn].some((k) => olaOwn.has(k))).toBe(false);
  });
});

describe("rule 5: IBAN only, never name or amount", () => {
  it("same amount and day across two own accounts without any IBAN is a coincidence", () => {
    expect(matchTransfers([row("1", "a", "-50.00"), row("2", "b", "50.00")], accounts)).toEqual([]);
  });

  it("a counterparty IBAN of a third party does not pair", () => {
    const rows = [row("1", "a", "-50.00", C_IBAN), row("2", "b", "50.00", C_IBAN)];
    expect(matchTransfers(rows, accounts)).toEqual([]);
  });

  it("an IBAN hit in either direction pairs", () => {
    expect(
      pairs(matchTransfers([row("1", "a", "-50.00", B_IBAN), row("2", "b", "50.00")], accounts)),
    ).toEqual([["1", "2"]]);
    expect(
      pairs(matchTransfers([row("1", "a", "-50.00"), row("2", "b", "50.00", A_IBAN)], accounts)),
    ).toEqual([["1", "2"]]);
  });

  it("the bare NRB and the PL-prefixed, spaced or apostrophe-guarded forms are one account", () => {
    const forms = [
      "10000000000000000000000006",
      "PL10 0000 0000 0000 0000 0000 0006",
      "'10000000000000000000000006",
    ];
    for (const cp of forms) {
      expect(
        pairs(matchTransfers([row("1", "a", "-50.00", cp), row("2", "b", "50.00")], accounts)),
      ).toEqual([["1", "2"]]);
    }
  });

  it("D-08.1: the raw IBAN is the key, a checksum-invalid number matches too", () => {
    const keys = transferAccountKeys([
      { key: "a", iban: "99114000000000000000000101" },
      { key: "b", iban: "99109000000000000000000202" },
    ]);
    const rows = [row("1", "a", "-1.00", "PL99109000000000000000000202"), row("2", "b", "1.00")];
    expect(pairs(matchTransfers(rows, keys))).toEqual([["1", "2"]]);
  });

  it("TransferRow carries no name: matching cannot read one", () => {
    const r: TransferRow = {
      ...row("1", "a", "-1.00"),
      // @ts-expect-error TransferRow has no counterpartyName: names are never a matching signal (rule 5)
      counterpartyName: "TEST",
    };
    expect(pairScore(r, row("2", "b", "1.00"), accounts)).toBeNull();
  });

  it("PARITY(Q8): a cash leg or expense (no counterparty IBAN, pool without IBAN) never pairs", () => {
    const keys = transferAccountKeys([
      { key: "a", iban: A_IBAN },
      { key: "pool", iban: null },
    ]);
    const rows = [
      row("1", "a", "-200.00"),
      row("2", "pool", "200.00"),
      row("3", "pool", "-200.00"),
    ];
    expect(matchTransfers(rows, keys)).toEqual([]);
  });

  it("an account missing from the keys, or with an empty IBAN, never matches an empty counterparty", () => {
    const keys = transferAccountKeys([{ key: "a", iban: "" }]);
    expect(pairScore(row("1", "a", "-1.00", "'"), row("2", "x", "1.00", ""), keys)).toBeNull();
  });
});

describe("tie-breaks (PARITY(Q2), PARITY(Q3))", () => {
  it("two equal inflows on the same day: the earlier row wins", () => {
    const rows = [row("1", "a", "-10.00", B_IBAN), row("5", "b", "10.00"), row("3", "b", "10.00")];
    expect(pairs(matchTransfers(rows, accounts))).toEqual([["1", "5"]]);
  });

  it("the nearest day wins over input order", () => {
    const rows = [
      row("1", "a", "-10.00", B_IBAN, "2024-02-05"),
      row("2", "b", "10.00", null, "2024-02-02"),
      row("3", "b", "10.00", null, "2024-02-06"),
    ];
    expect(pairs(matchTransfers(rows, accounts))).toEqual([["1", "3"]]);
  });

  it("two outflows for one inflow: the earlier date wins, then the earlier row", () => {
    const later = row("1", "a", "-10.00", B_IBAN, "2024-02-03");
    const earlier = row("2", "a", "-10.00", B_IBAN, "2024-02-02");
    const inc = row("3", "b", "10.00", null, "2024-02-03");
    expect(pairs(matchTransfers([later, earlier, inc], accounts))).toEqual([["2", "3"]]);
    const twin = row("4", "a", "-10.00", B_IBAN, "2024-02-02");
    expect(pairs(matchTransfers([twin, earlier, inc], accounts))).toEqual([["4", "3"]]);
  });

  it("3 days apart pairs, 4 do not; maxDays widens it", () => {
    const out = row("1", "a", "-10.00", B_IBAN, "2024-02-01");
    expect(
      matchTransfers([out, row("2", "b", "10.00", null, "2024-02-04")], accounts),
    ).toHaveLength(1);
    expect(
      matchTransfers([out, row("2", "b", "10.00", null, "2024-01-29")], accounts),
    ).toHaveLength(1);
    expect(matchTransfers([out, row("2", "b", "10.00", null, "2024-02-05")], accounts)).toEqual([]);
    expect(
      matchTransfers([out, row("2", "b", "10.00", null, "2024-02-05")], accounts, { maxDays: 4 }),
    ).toHaveLength(1);
  });

  it("legs on the same account never pair", () => {
    expect(
      matchTransfers([row("1", "a", "-10.00", A_IBAN), row("2", "a", "10.00", A_IBAN)], accounts),
    ).toEqual([]);
  });
});

describe("amount keys (PARITY(Q4), PARITY(Q5))", () => {
  it("zero, also -0, is never keyed and never matched", () => {
    expect(transferAmountKey(D("0"))).toBeNull();
    expect(transferAmountKey(D("-0.00"))).toBeNull();
    expect(matchTransfers([row("1", "a", "-0", B_IBAN), row("2", "b", "0")], accounts)).toEqual([]);
  });

  it("sub-cent amounts share the key 0.00 and pair", () => {
    expect([D("0.004"), D("-0.001"), D("-0.005")].map(transferAmountKey)).toEqual([
      "0.00",
      "0.00",
      "0.00",
    ]);
    expect(
      pairs(matchTransfers([row("1", "a", "-0.001", B_IBAN), row("2", "b", "0.004")], accounts)),
    ).toEqual([["1", "2"]]);
  });

  it("above 28 digits the outflow is context-rounded before formatting, the inflow is not", () => {
    const long = "1.014999999999999999999999999999";
    expect(transferAmountKey(D(long))).toBe("1.01");
    expect(transferAmountKey(D(`-${long}`))).toBe("1.02");
    const rows = [row("1", "a", `-${long}`, B_IBAN), row("2", "b", long), row("3", "b", "1.02")];
    expect(pairs(matchTransfers(rows, accounts))).toEqual([["1", "3"]]);
  });

  it("scale and exponent forms of one value share a key", () => {
    expect(["100", "100.0", "1E+2", "-100.00"].map((s) => transferAmountKey(D(s)))).toEqual([
      "100.00",
      "100.00",
      "100.00",
      "100.00",
    ]);
  });
});

// ------------------------------------------------------------------ properties

const NUMBERS = [
  "99114000000000000000000101",
  "99109000000000000000000202",
  "99105000000000000000000303",
];
const FORMS = [(n: string) => n, (n: string) => `PL${n}`, (n: string) => `'${n}`];
const AMOUNTS = ["10.00", "10", "25.50", "0.004", "0.001", "7"];

function randomCase(rnd: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const keys = transferAccountKeys(
    NUMBERS.map((n, i) => ({ key: `acc${i}`, iban: rnd() < 0.15 ? null : n })),
  );
  const n = Math.floor(rnd() * 40);
  const rows: TransferRow[] = Array.from({ length: n }, (_, i) => {
    const sign = rnd() < 0.5 ? "-" : "";
    return row(
      `r${i}`,
      `acc${Math.floor(rnd() * NUMBERS.length)}`,
      `${sign}${pick(AMOUNTS)}`,
      rnd() < 0.3 ? null : pick(FORMS)(pick(NUMBERS)),
      addDays("2024-02-01", Math.floor(rnd() * 9)),
    );
  });
  return { rows, keys };
}

/** A shuffle that keeps the order of the inflows of each key and of the outflows of each day. */
function orderPreservingShuffle(rows: readonly TransferRow[], rnd: () => number): TransferRow[] {
  const queues = new Map<string, TransferRow[]>();
  for (const r of rows) {
    const k = transferAmountKey(r.amount);
    const q =
      k === null ? `zero:${r.key}` : r.amount.isSigned() ? `out:${r.bookingDate}` : `in:${k}`;
    queues.set(q, [...(queues.get(q) ?? []), r]);
  }
  const out: TransferRow[] = [];
  const live = [...queues.values()];
  while (live.length > 0) {
    const i = Math.floor(rnd() * live.length);
    const q = live[i] as TransferRow[];
    out.push(q.shift() as TransferRow);
    if (q.length === 0) live.splice(i, 1);
  }
  return out;
}

describe("matchTransfers: properties", () => {
  const RUNS = 30;

  it("(a) rows of one amount key match exactly as within the whole set", () => {
    const rnd = prng(20261101);
    for (let run = 0; run < RUNS; run++) {
      const { rows, keys } = randomCase(rnd);
      const all = matchTransfers(rows, keys);
      const byKey = new Map(rows.map((r) => [r.key, transferAmountKey(r.amount)]));
      for (const k of new Set(byKey.values())) {
        if (k === null) continue;
        const restricted = matchTransfers(
          rows.filter((r) => byKey.get(r.key) === k),
          keys,
        );
        expect(restricted).toEqual(all.filter((p) => byKey.get(p.out) === k));
      }
    }
  });

  it("(b) the output is a matching of IBAN-hit legs within maxDays", () => {
    const rnd = prng(7);
    for (let run = 0; run < RUNS; run++) {
      const { rows, keys } = randomCase(rnd);
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const seen = new Set<string>();
      for (const p of matchTransfers(rows, keys)) {
        const out = byKey.get(p.out) as TransferRow;
        const inc = byKey.get(p.in) as TransferRow;
        expect(seen.has(p.out) || seen.has(p.in)).toBe(false);
        seen.add(p.out).add(p.in);
        expect(out.amount.isSigned() && !inc.amount.isSigned() && !inc.amount.isZero()).toBe(true);
        expect(transferAmountKey(out.amount)).toBe(transferAmountKey(inc.amount));
        expect(out.account).not.toBe(inc.account);
        expect(Math.abs(daysBetween(out.bookingDate, inc.bookingDate))).toBeLessThanOrEqual(3);
        expect(pairScore(out, inc, keys)).toBe(3);
      }
    }
  });

  it("(c) reordering that keeps inflows per key and outflows per day in order changes nothing", () => {
    const rnd = prng(99);
    for (let run = 0; run < RUNS; run++) {
      const { rows, keys } = randomCase(rnd);
      expect(matchTransfers(orderPreservingShuffle(rows, rnd), keys)).toEqual(
        matchTransfers(rows, keys),
      );
    }
  });

  it("(d) the same input gives the same output", () => {
    const rnd = prng(3);
    for (let run = 0; run < RUNS; run++) {
      const { rows, keys } = randomCase(rnd);
      expect(matchTransfers(rows, keys)).toEqual(matchTransfers([...rows], new Map(keys)));
    }
  });
});
