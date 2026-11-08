/// <reference types="node" />
// Test helpers of the transfer port: the Python scenarios of `budget-transfers.jsonl` (recorded from
// the retired Python app), their TS replay, and a seeded PRNG.

import { D } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import { loadVectors, Mismatches } from "../../testing/vectors.js";
import { matchTransfers, type TransferRow } from "../transfers.js";

type Row = [number, number, string, string, string | null];

/** One Python scenario: accounts `[id, iban]`, rows in id order, Python's pairs in creation order. */
export interface TransferScenario {
  readonly index: number;
  readonly staleReset: boolean;
  readonly accounts: readonly [number, string | null][];
  readonly rows: readonly Row[];
  readonly pairs: readonly [number, number][];
}

const file = loadVectors("budget-transfers");

/** The EXPLAIN QUERY PLAN detail of Python's ungrouped-rows query (row 1 of the file). */
export const PYTHON_PLAN = (file.rows[0] as [string, string])[1];

export const TRANSFER_SCENARIOS: readonly TransferScenario[] = file.rows
  .slice(1)
  .map((r, index) => {
    const [, staleReset, accounts, rows, pairs] = r as [
      string,
      boolean,
      TransferScenario["accounts"],
      TransferScenario["rows"],
      TransferScenario["pairs"],
    ];
    return { index, staleReset, accounts, rows, pairs };
  });

/** The scenario as `matchTransfers` input: rows in Python id order, accounts keyed by `iban_key`. */
function scenarioInput(s: TransferScenario): {
  rows: TransferRow[];
  accounts: Map<string, string>;
} {
  return {
    rows: s.rows.map(([id, account, bookingDate, amount, counterpartyIban]) => ({
      key: String(id),
      account: String(account),
      bookingDate,
      amount: D(amount),
      counterpartyIban,
    })),
    accounts: new Map(s.accounts.map(([id, iban]) => [String(id), ibanKey(iban)])),
  };
}

/** Replays `scenarios` through `matchTransfers`; one check per scenario (pairs compared as arrays). */
export function replayScenarios(scenarios: readonly TransferScenario[]): Mismatches {
  const m = new Mismatches();
  for (const s of scenarios) {
    const { rows, accounts } = scenarioInput(s);
    const got = matchTransfers(rows, accounts).map((p) => [Number(p.out), Number(p.in)]);
    m.check(`scenario ${s.index}`, got, s.pairs);
  }
  return m;
}

/** Deterministic PRNG (mulberry32): tests never use Math.random. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
