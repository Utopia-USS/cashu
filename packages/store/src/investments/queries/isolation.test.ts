// Vault (profile) isolation of the investments queries and commands. Translates the store-level
// meaning of Python tests/investments/persistence/test_invp_isolation.py (two profiles with the same
// history see the same thing, an empty one sees nothing, writes through one never reach the other)
// and test_al_profile_instruments.py (one profile's classification of a security never changes
// another's). One view database per vault makes a cross-vault read structurally impossible; these
// tests check that every query sees only its vault and that every command refuses another vault's
// gids. The HTTP route list check of the oracle is S36's. Synthetic data only.
import { Decimal } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import {
  classifyInstrument,
  createInstrument,
  createThesis,
  deleteThesis,
  mergeInstruments,
  recordDecision,
  setInstrumentStatus,
  setManualValuation,
  snoozeSignalCommand,
  undoDecision,
  updateThesis,
} from "../commands/index.js";
import {
  applyRaw,
  brokerage,
  otherVault,
  raw,
  rawGid,
  stock,
  type Vault,
  vault,
} from "../commands/testing/fixtures.js";
import * as q from "./index.js";

const NOW = "2026-10-31T12:00:00Z";

/** The same synthetic history in a vault; returns the vault-specific gids. */
function household(v: Vault, base = 0) {
  const account = brokerage(v, "DIF");
  const xmpl = stock(v, "XMPL", "US0000000001", { currency: "USD" });
  const abc = stock(v, "ABC", "PL0000000ABC");
  const h = "e".repeat(64);
  applyRaw(v, [
    {
      type: "invTxn.imported",
      gid: v.det("inv_transactions", [account, h]),
      data: {
        account,
        batch: null,
        type: "buy",
        tradeDate: "2026-01-05",
        settleDate: null,
        instrument: xmpl,
        quantity: "3",
        price: "100",
        currency: "USD",
        grossAmount: "300",
        fee: "0",
        tax: "0",
        cashAmount: "-300",
        cashCurrency: "USD",
        fxRate: null,
        splitRatio: null,
        note: null,
        source: "import",
        externalRef: null,
        dedupHash: h,
        createdAt: "2026-01-05T10:00:00.000Z",
      },
    },
    raw.watchAdded(v, abc, { note: "Example watch" }),
    raw.alertCreated(rawGid(base + 1), xmpl, { title: "XMPL above 50" }),
    raw.signalOpened(rawGid(base + 2), `drawdown|i:${xmpl}`, {
      instrument: xmpl,
      account,
    }),
  ]);
  const signal = q.openSignals(v.store.read.bind(v.store))[0]?.gid ?? "";
  const decision = v.value(recordDecision, { action: "held", signals: [signal] }).decision;
  const thesis = v.value(createThesis, {
    instrument: xmpl,
    entryType: "trend",
    thesis: "Example thesis",
  }).thesis;
  v.value(setManualValuation, {
    instrument: xmpl,
    asOf: "2026-02-01",
    unitValue: "99",
    currency: "USD",
  });
  return { account, xmpl, abc, signal, decision, thesis };
}

/** Every investments query of the vault, gids and Decimals made comparable across vaults. */
function snapshot(v: Vault, xmpl: string | undefined): unknown {
  const read = v.store.read.bind(v.store);
  const accounts = q.brokerageAccounts(read).map((a) => a.gid);
  const data = {
    instruments: q.allInstruments(read),
    shared: q.allInstruments(read, { shared: true }),
    vaultInstruments: q.vaultInstrumentGids(read),
    overrides: q.overrides(read),
    accounts: q.brokerageAccounts(read),
    settings: accounts.map((a) => q.accountSettings(read, a)),
    transactions: q.transactions(read),
    renames: q.renames(read),
    valuations: q.manualValuations(read),
    snapshots: accounts.map((a) => q.latestPositionSnapshot(read, a)),
    open: q.openSignals(read),
    closed: q.closedSignals(read),
    alertSignals: q.openAlertSignals(read),
    runs: q.ruleRuns(read),
    decisions: q.decisions(read),
    theses: q.theses(read),
    alerts: q.alerts(read, NOW),
    counts: q.alertCounts(read, NOW),
    watchlist: q.watchlist(read),
    byInstrument:
      xmpl === undefined
        ? null
        : {
            instrument: q.loadInstrument(read, xmpl) ?? null,
            theses: q.theses(read, xmpl),
            decisions: q.decisions(read, { instrument: xmpl }),
            watch: q.watchRowFor(read, xmpl) ?? null,
          },
  };
  const GID =
    /[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const text = JSON.stringify(data, (_k, val: unknown) => {
    if (val instanceof Decimal) return val.toString();
    if (val instanceof Map) return Object.fromEntries([...val].sort());
    if (val instanceof Set) return [...val].sort();
    return val;
  });
  return JSON.parse(text.replace(GID, "<gid>"));
}

describe("two vaults with the same history", () => {
  it("see exactly the same thing; an empty vault sees nothing", () => {
    const a = vault();
    const ha = household(a);
    const reference = snapshot(a, ha.xmpl);
    const empty = otherVault();
    const e = snapshot(empty, ha.xmpl) as Record<string, unknown>;
    for (const key of [
      "instruments",
      "accounts",
      "transactions",
      "open",
      "decisions",
      "theses",
      "alerts",
      "watchlist",
      "valuations",
    ]) {
      expect(e[key], key).toEqual([]);
    }
    expect(e.byInstrument).toEqual({ instrument: null, theses: [], decisions: [], watch: null });
    const b = otherVault();
    const hb = household(b, 100);
    expect(hb.xmpl).not.toBe(ha.xmpl); // instrument gids are per vault (salted DET)
    expect(snapshot(b, hb.xmpl)).toEqual(reference);
    expect(snapshot(a, ha.xmpl)).toEqual(reference);
  });
});

describe("writes through one vault never touch another", () => {
  it("refuses another vault's gids and leaves its view unchanged", () => {
    const a = vault();
    const ha = household(a);
    const only = a.value(createInstrument, {
      name: "Only SA",
      currency: "PLN",
      assetClass: "equity",
      aliases: [{ namespace: "xtb", value: "ONLY.PL" }],
    }).gid;
    const b = otherVault();
    const hb = household(b, 100);
    const reference = snapshot(b, hb.xmpl);
    const refused = (out: { ok: boolean; reason?: string }) => (out.ok ? "ok" : out.reason);
    expect(refused(b.run(recordDecision, { action: "sold", signals: [ha.signal] }))).toBe(
      "no_signal",
    );
    expect(refused(b.run(recordDecision, { action: "held", instrument: only }))).toBe(
      "no_instrument",
    );
    expect(refused(b.run(undoDecision, { decision: ha.decision }))).toBe("no_decision");
    expect(refused(b.run(snoozeSignalCommand, { signal: ha.signal, until: null }))).toBe(
      "not_open",
    );
    expect(refused(b.run(updateThesis, { id: ha.thesis, values: { thesis: "x" } }))).toBe(
      "no_thesis",
    );
    expect(refused(b.run(deleteThesis, { id: ha.thesis }))).toBe("no_thesis");
    expect(
      refused(b.run(createThesis, { instrument: only, entryType: "trend", thesis: "x" })),
    ).toBe("no_instrument");
    expect(refused(b.run(classifyInstrument, { instrument: only, tags: ["x"] }))).toBe(
      "no_instrument",
    );
    expect(
      refused(
        b.run(setManualValuation, {
          instrument: only,
          asOf: "2026-01-01",
          unitValue: "1",
          currency: "PLN",
        }),
      ),
    ).toBe("no_instrument");
    expect(refused(b.run(mergeInstruments, { source: only, target: hb.xmpl }))).toBe(
      "no_instrument",
    );
    // the vault's own writes after all that leave the other's view unchanged
    a.value(recordDecision, { action: "sold", signals: [ha.signal] });
    a.value(setManualValuation, {
      instrument: ha.xmpl,
      asOf: "2026-02-02",
      unitValue: "1",
      currency: "USD",
    });
    a.value(classifyInstrument, { instrument: ha.xmpl, status: "frozen", name: "Private label" });
    a.value(mergeInstruments, { source: only, target: ha.abc });
    expect(snapshot(b, hb.xmpl)).toEqual(reference);
  });
});

describe("per-vault instrument attributes (test_al_profile_instruments)", () => {
  it("one vault's classification and import delisting never change another vault's view", () => {
    const a = vault();
    const b = otherVault();
    const ha = household(a);
    const hb = household(b, 100);
    const readA = a.store.read.bind(a.store);
    const readB = b.store.read.bind(b.store);
    const before = q.loadInstrument(readB, hb.xmpl);
    a.value(classifyInstrument, {
      instrument: ha.xmpl,
      status: "frozen",
      name: "Anna private label",
      tags: ["private"],
      region: "",
    });
    a.value(classifyInstrument, { instrument: ha.abc, valuationMode: "cost" });
    a.value(setInstrumentStatus, { instrument: ha.abc, status: "delisted" }); // an import delisting
    const seen = q.loadInstrument(readA, ha.xmpl);
    expect([seen?.name, seen?.status, seen?.tags, seen?.region]).toEqual([
      "Anna private label",
      "frozen",
      ["private"],
      null,
    ]);
    expect(q.loadInstrument(readA, ha.abc)).toMatchObject({
      valuationMode: "cost",
      status: "delisted",
    });
    // the vault's shared row keeps the market identity and defaults
    expect(q.loadInstrument(readA, ha.xmpl, { shared: true })).toMatchObject({
      name: "XMPL SA",
      status: "active",
      tags: [],
    });
    expect(q.loadInstrument(readB, hb.xmpl)).toEqual(before);
    expect(q.loadInstrument(readB, hb.abc)).toMatchObject({
      valuationMode: "market",
      status: "active",
    });
  });
});
