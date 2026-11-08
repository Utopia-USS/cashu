// Test kit for the investments materializers: complete synthetic payloads, valid DET gids, row reads
// with gids in place of view ids, and a convergence driver (shuffled delivery with re-delivered
// duplicates, random batches, rebuild). Synthetic data only.
import { expect } from "vitest";
import { detGid, type GidTable } from "../../gid.js";
import type { Store } from "../../materialize.js";
import { viewHash } from "../../snapshot.js";
import { chunked, shuffled } from "../../testing/random.js";
import {
  EventFactory,
  openTestStore,
  TEST_SALT,
  type TestEnvelope,
  testUlid,
} from "../../testing/store.js";

export const DEV_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const DEV_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export const det = (table: GidTable, ...parts: string[]) => detGid(TEST_SALT, table, parts);
export const ulid = (n: number) => testUlid("01JE", n);

/** Required payload fields the tests leave out (values irrelevant to the rule under test). */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  "account.opened": {
    bank: "xtb",
    externalId: null,
    iban: null,
    currency: "PLN",
    type: "brokerage",
    name: "Rachunek",
    keys: [],
  },
  "instrument.created": {
    name: "Spolka",
    currency: "PLN",
    assetClass: "equity",
    symbol: null,
    isin: null,
    mic: null,
    region: null,
    sector: null,
    tags: [],
    needsClassification: false,
    valuationMode: "market",
    status: "active",
    creationAlias: null,
  },
  "instrument.aliasAdded": { guessed: false },
  "invImport.recorded": {
    importer: "cashu",
    broker: "xtb",
    fileName: "historia.csv",
    fileSha256: "a".repeat(64),
    txnCount: 1,
    duplicateCount: 0,
    positionCount: 0,
    renameCount: 0,
    statusChangeCount: 0,
    instrumentCount: 0,
    correctionCount: 0,
    warnings: [],
  },
  "invTxn.imported": {
    batch: null,
    type: "buy",
    tradeDate: "2026-03-02",
    settleDate: null,
    instrument: null,
    quantity: "10",
    price: "12.50",
    currency: "PLN",
    grossAmount: "125.00",
    fee: "0",
    tax: "0",
    cashAmount: "-125.00",
    cashCurrency: "PLN",
    fxRate: null,
    splitRatio: null,
    note: null,
    source: "import",
    externalRef: null,
    createdAt: "2026-03-02T10:00:00.000Z",
  },
  "position.snapshotImported": {
    quantity: "10",
    currency: "PLN",
    avgPrice: null,
    marketValue: null,
    batch: null,
  },
  "position.snapshotUpdated": {
    quantity: "10",
    currency: "PLN",
    avgPrice: null,
    marketValue: null,
    batch: null,
  },
  "instrumentRename.recorded": { note: null, batch: null },
  "strategy.versionSaved": { yamlText: "cele: []", mdText: null, state: "valid", issues: [] },
  "ruleRun.finished": {
    trigger: "worker",
    asOf: "2026-03-02",
    status: "ok",
    strategyVersion: null,
    stats: {},
    errors: [],
    report: { new: [], escalated: [] },
    startedAt: "2026-03-02T06:00:00.000Z",
    finishedAt: "2026-03-02T06:00:05.000Z",
  },
  "signal.opened": {
    ruleId: "rule",
    kind: "test",
    severity: "info",
    polarity: "neutral",
    message: "",
    instrument: null,
    account: null,
    payload: {},
    run: null,
  },
  "alert.created": {
    instrument: null,
    scope: "portfolio",
    kind: "weight_above",
    params: { threshold: "0.2" },
    polarity: "negative",
    severity: "info",
    title: "Waga powyzej 20%",
    note: null,
    source: "user",
    createdBy: "app",
    cooldownDays: null,
    expiresAt: null,
  },
  "thesis.created": {
    entryType: "trend",
    thesis: "Teza",
    invalidation: null,
    exitPlan: null,
    sizePlan: null,
  },
  "plannedDeposit.created": {
    account: null,
    amount: "500",
    currency: "PLN",
    plannedDate: "2026-04-01",
    note: null,
  },
  "researchRun.started": { scope: {}, createdBy: "agent" },
  "note.added": {
    run: null,
    instrument: null,
    theme: null,
    segment: null,
    kind: "news",
    polarity: "neutral",
    strength: 1,
    thesisRelation: "none",
    thesisField: null,
    title: "Notatka",
    summary: "Streszczenie.",
    sources: [{ title: "Zrodlo", url: "https://example.org/z" }],
    details: null,
    candidateKey: null,
    signal: null,
    observedAt: "2026-03-02T08:00:00.000Z",
    expiresAt: "2026-04-01T08:00:00.000Z",
    createdBy: "agent",
  },
  "review.done": { module: "investments", notes: null, stats: {} },
};

/** An event factory that fills in the defaults; `wall` is ms after 2026-10-31T12:00:00Z. */
export class Events {
  readonly #f: EventFactory;
  constructor(device = DEV_A, prefix = "01JC") {
    this.#f = new EventFactory(device, prefix);
  }

  make(
    type: string,
    gid: string,
    data: Record<string, unknown> = {},
    opts: { wall?: number; counter?: number; cause?: string; device?: string } = {},
  ): TestEnvelope {
    return this.#f.make(type, gid, { ...(DEFAULTS[type] ?? {}), ...data }, opts);
  }
}

/** A created instrument and its creation alias claim (gids are DET as a writer computes them). */
export function instrument(
  ev: Events,
  alias: [string, string],
  data: Record<string, unknown> = {},
  opts: { wall?: number; device?: string } = {},
): { gid: string; events: TestEnvelope[] } {
  const creationAlias = `${alias[0]}:${alias[1]}`;
  const gid = det("inv_instruments", creationAlias);
  return {
    gid,
    events: [
      ev.make("instrument.created", gid, { creationAlias, ...data }, opts),
      claim(ev, gid, alias, opts),
    ],
  };
}

/** `instrument.aliasAdded` of `alias` for `instrument`. */
export function claim(
  ev: Events,
  instrumentGid: string,
  alias: [string, string],
  opts: { wall?: number; device?: string } = {},
): TestEnvelope {
  return ev.make(
    "instrument.aliasAdded",
    det("inv_instrument_aliases", alias[0], alias[1]),
    { instrument: instrumentGid, namespace: alias[0], value: alias[1] },
    opts,
  );
}

/** A brokerage account opened under `gid` with identity `keys`. */
export function account(
  ev: Events,
  gid: string,
  keys: string[] = [],
  opts: { wall?: number; device?: string } = {},
): TestEnvelope {
  return ev.make("account.opened", gid, { keys }, opts);
}

/**
 * Rows of `table` with every reference column replaced by the referenced gid (`<col>` -> gid) and
 * `id` dropped, sorted by gid.
 */
export function rows(store: Store, table: string): Record<string, unknown>[] {
  const def = store.publicTables().find((t) => t.name === table);
  if (def === undefined) throw new Error(`no public table ${table}`);
  const gidOf = new Map(
    store
      .read<{ id: number; gid: string }>("SELECT id, gid FROM view_ids")
      .map((r) => [r.id, r.gid]),
  );
  return store.read<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY gid`).map((r) => {
    const out: Record<string, unknown> = { ...r };
    delete out.id;
    for (const c of def.columns) {
      if (c.ref !== undefined && typeof r[c.name] === "number") {
        out[c.name] = gidOf.get(r[c.name] as number);
      }
      if (c.json === true && typeof r[c.name] === "string") {
        out[c.name] = JSON.parse(r[c.name] as string) as unknown;
      }
    }
    return out;
  });
}

/** The one row of `table` with `gid` (with references as gids). */
export function row(store: Store, table: string, gid: string): Record<string, unknown> | undefined {
  return rows(store, table).find((r) => r.gid === gid);
}

const ORDERS = 4;

/**
 * Deliver `events` in ORDERS shuffles (single events for even k, random batches for odd k) plus three
 * re-delivered duplicates; every delivery gives the same view hash, and a rebuild gives it too.
 * `check` runs on every final store; `invariant` after every batch. Returns the last store.
 */
export function converge(
  events: readonly TestEnvelope[],
  check: (store: Store) => void,
  invariant?: (store: Store) => void,
): Store {
  let hash: string | undefined;
  let last: Store | undefined;
  for (let k = 0; k < ORDERS; k++) {
    const order = shuffled(events, k + 1);
    const withDupes = [...order, ...shuffled(order, k + 1000).slice(0, 3)];
    const store = openTestStore();
    const batches = k % 2 === 0 ? withDupes.map((e) => [e]) : chunked(withDupes, k + 7);
    for (const b of batches) {
      const r = store.applyEnvelopes(b);
      expect(r.rejected).toEqual([]);
      expect(r.parked).toBe(0);
      invariant?.(store);
    }
    check(store);
    const h = viewHash(store).hash;
    hash ??= h;
    expect(h).toBe(hash);
    store.rebuild();
    expect(viewHash(store).hash).toBe(hash);
    last = store;
  }
  return last as Store;
}
