import { describe, expect, it } from "vitest";
import {
  aliasOwner,
  allInstruments,
  instrumentByAlias,
  instrumentByIsin,
  instrumentsBySymbol,
  loadInstrument,
  overrides,
} from "../queries/instruments.js";
import { manualValuations } from "../queries/transactions.js";
import {
  addInstrumentAliases,
  classifyInstrument,
  createInstrument,
  setInstrumentPlan,
  setInstrumentSegment,
  setInstrumentStatus,
  setManualValuation,
} from "./instruments.js";
import { type Vault, vault } from "./testing/fixtures.js";

/** A USD stock with a guessed yahoo alias and a broker alias. */
function storedInstrument(v: Vault, symbol = "XMPL", isin = "US0000000001", yahoo = "XMPL") {
  return v.value(createInstrument, {
    name: `${symbol} Corp`,
    currency: "USD",
    assetClass: "equity",
    symbol,
    isin,
    mic: "XNAS",
    aliases: [
      { namespace: "yahoo", value: yahoo, guessed: true },
      { namespace: "examplebroker", value: symbol },
    ],
  }).gid;
}

describe("createInstrument", () => {
  it("stores the instrument under the DET gid of its ISIN with every alias claimed", () => {
    const v = vault();
    const gid = storedInstrument(v);
    expect(gid).toBe(v.det("inv_instruments", ["isin:US0000000001"]));
    const i = loadInstrument(v.store.read.bind(v.store), gid);
    expect(i).toMatchObject({ name: "XMPL Corp", currency: "USD", isin: "US0000000001" });
    expect(i?.aliases.map((a) => [a.namespace, a.value, a.guessed])).toEqual([
      ["examplebroker", "XMPL", false],
      ["isin", "US0000000001", false],
      ["yahoo", "XMPL", true],
    ]);
    expect(i?.valuationMode).toBe("market"); // the asset class default
  });

  it("returns the holder of its creation alias instead of a second instrument", () => {
    const v = vault();
    const gid = storedInstrument(v);
    const again = v.run(createInstrument, {
      name: "Other",
      currency: "USD",
      assetClass: "equity",
      isin: "us0000000001",
    });
    expect(again).toMatchObject({ ok: true, value: { gid, created: false }, events: [] });
  });

  it("uses the first alias without an ISIN, a ULID without any alias", () => {
    const v = vault();
    const byAlias = v.value(createInstrument, {
      name: "Fundusz",
      currency: "PLN",
      assetClass: "fund",
      aliases: [{ namespace: "examplebroker", value: " FUND1 " }],
    });
    expect(byAlias.gid).toBe(v.det("inv_instruments", ["examplebroker:FUND1"]));
    const bare = v.value(createInstrument, {
      name: "Pozyczka",
      currency: "PLN",
      assetClass: "claim",
    });
    expect(bare.gid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(loadInstrument(v.store.read.bind(v.store), bare.gid)?.valuationMode).toBe("manual");
  });
});

describe("instrument lookup", () => {
  it("answers by ISIN, alias, symbol and confirmed aliases", () => {
    const v = vault();
    const iid = storedInstrument(v);
    const read = v.store.read.bind(v.store);
    expect(instrumentByIsin(read, "us0000000001")?.id).toBe(iid);
    expect(instrumentByAlias(read, "isin", "US0000000001")?.id).toBe(iid);
    expect(instrumentByAlias(read, "examplebroker", "XMPL")?.id).toBe(iid);
    expect(instrumentByAlias(read, "yahoo", "XMPL")?.id).toBe(iid); // guessed aliases count for planning
    expect(instrumentsBySymbol(read, "xmpl", "XNAS").map((i) => i.id)).toEqual([iid]);
    expect(instrumentsBySymbol(read, "XMPL", "XWAR")).toEqual([]);
    expect(instrumentByAlias(read, "yahoo", "XMPL", { confirmedOnly: true })).toBeUndefined();
    expect(instrumentByAlias(read, "examplebroker", "XMPL", { confirmedOnly: true })?.id).toBe(iid);
  });
});

describe("classifyInstrument", () => {
  it("classifies in the vault's override row; aliases are market identity", () => {
    const v = vault();
    const iid = storedInstrument(v);
    const other = storedInstrument(v, "ABC", "PLABC0000016", "ABC.WA");
    const read = v.store.read.bind(v.store);
    v.value(classifyInstrument, {
      instrument: iid,
      assetClass: "etf",
      tags: ["global_equity", " ", "global_equity"],
      aliases: [{ namespace: "yahoo", value: "XMPL" }],
    });
    const row = overrides(read, [iid]).get(iid);
    expect([row?.assetClass, row?.tags, row?.needsClassification]).toEqual([
      "etf",
      ["global_equity"],
      false,
    ]);
    // the shared row keeps the market defaults; the vault sees its classification
    expect(loadInstrument(read, iid, { shared: true })?.assetClass).toBe("equity");
    expect(loadInstrument(read, iid)?.assetClass).toBe("etf");
    expect(loadInstrument(read, iid)?.tags).toEqual(["global_equity"]);
    // an alias of another instrument refuses (claiming it would merge the two)
    expect(
      v.run(classifyInstrument, {
        instrument: iid,
        aliases: [{ namespace: "yahoo", value: "ABC.WA" }],
      }),
    ).toEqual({ ok: false, reason: "alias_taken" });
    expect(v.run(classifyInstrument, { instrument: other, valuationMode: "guess" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    v.value(classifyInstrument, { instrument: other, assetClass: "treasury_bond" });
    // follows the class default when it was the default
    expect(overrides(read, [other]).get(other)?.valuationMode).toBe("cost");
  });

  it("confirms a guessed alias: the re-claim takes effect in the view (events.md 8.6)", () => {
    const v = vault();
    const iid = storedInstrument(v);
    expect(aliasOwner(v.store.read.bind(v.store), "yahoo", "XMPL")?.guessed).toBe(true);
    const out = v.run(addInstrumentAliases, {
      instrument: iid,
      aliases: [{ namespace: "yahoo", value: "XMPL" }],
    });
    expect(out.ok && out.events.map((e) => [e.type, e.data.guessed])).toEqual([
      ["instrument.aliasAdded", false],
    ]);
    expect(aliasOwner(v.store.read.bind(v.store), "yahoo", "XMPL")).toEqual({
      instrument: iid,
      guessed: false,
    });
    expect(
      instrumentByAlias(v.store.read.bind(v.store), "yahoo", "XMPL", { confirmedOnly: true })?.id,
    ).toBe(iid);
  });

  it("an ISIN alias fills the display ISIN when the instrument has none", () => {
    const v = vault();
    const g = v.value(createInstrument, {
      name: "Fundusz",
      currency: "PLN",
      assetClass: "fund",
      aliases: [{ namespace: "examplebroker", value: "F1" }],
    }).gid;
    v.value(addInstrumentAliases, {
      instrument: g,
      aliases: [{ namespace: "isin", value: "pl0000000002" }],
    });
    expect(loadInstrument(v.store.read.bind(v.store), g)?.isin).toBe("PL0000000002");
  });

  it("refuses an unknown instrument and clears region / sector with an empty string", () => {
    const v = vault();
    const iid = storedInstrument(v);
    expect(v.run(classifyInstrument, { instrument: v.det("inv_instruments", ["isin:X"]) })).toEqual(
      {
        ok: false,
        reason: "no_instrument",
      },
    );
    v.value(classifyInstrument, { instrument: iid, region: "US", sector: "Tech" });
    v.value(classifyInstrument, { instrument: iid, region: "", reviewed: false });
    const i = loadInstrument(v.store.read.bind(v.store), iid);
    expect([i?.region, i?.sector]).toEqual([null, "Tech"]);
  });
});

describe("status, plan, segment, manual valuation", () => {
  it("setInstrumentStatus writes only a change, for this vault", () => {
    const v = vault();
    const iid = storedInstrument(v);
    expect(v.value(setInstrumentStatus, { instrument: iid, status: "active" })).toEqual({
      changed: false,
    });
    expect(v.value(setInstrumentStatus, { instrument: iid, status: "frozen" })).toEqual({
      changed: true,
    });
    const read = v.store.read.bind(v.store);
    expect(loadInstrument(read, iid)?.status).toBe("frozen");
    expect(loadInstrument(read, iid, { shared: true })?.status).toBe("active");
  });

  it("setInstrumentPlan validates the reason, held-only plans and clears with null", () => {
    const v = vault();
    const iid = storedInstrument(v);
    const read = v.store.read.bind(v.store);
    expect(v.run(setInstrumentPlan, { instrument: iid, plan: "reduce", held: false })).toEqual({
      ok: false,
      reason: "needs_held",
    });
    expect(
      v.run(setInstrumentPlan, {
        instrument: iid,
        plan: "buy",
        held: false,
        reason: "x".repeat(281),
      }),
    ).toEqual({ ok: false, reason: "reason_too_long" });
    expect(v.run(setInstrumentPlan, { instrument: iid, plan: "sell", held: true })).toMatchObject({
      reason: "invalid_input",
    });
    v.value(setInstrumentPlan, {
      instrument: iid,
      plan: "buy",
      held: false,
      reason: "  tanio \n teraz ",
    });
    const i = loadInstrument(read, iid);
    expect([i?.plan, i?.planReason]).toEqual(["buy", "tanio teraz"]);
    expect(i?.planAt).toMatchObject({ date: "2026-10-31", hour: 12 });
    v.value(setInstrumentPlan, { instrument: iid, plan: null, held: true, reason: "ignored" });
    expect(overrides(read, [iid]).get(iid)).toMatchObject({
      plan: null,
      planReason: null,
      planAt: null,
    });
  });

  it("setInstrumentSegment: catalog keys only, the agent never overrides the owner", () => {
    const v = vault();
    const iid = storedInstrument(v);
    const read = v.store.read.bind(v.store);
    expect(
      v.run(setInstrumentSegment, { instrument: iid, segment: "macro_rates", by: "owner" }),
    ).toEqual({
      ok: false,
      reason: "not_instrument_segment",
    });
    expect(v.run(setInstrumentSegment, { instrument: iid, segment: "nope", by: "owner" })).toEqual({
      ok: false,
      reason: "unknown_segment",
    });
    expect(
      v.value(setInstrumentSegment, { instrument: iid, segment: "software", by: "agent" }),
    ).toEqual({
      changed: true,
    });
    expect(
      v.value(setInstrumentSegment, { instrument: iid, segment: "gold", by: "owner" }),
    ).toEqual({
      changed: true,
    });
    expect(v.run(setInstrumentSegment, { instrument: iid, segment: null, by: "agent" })).toEqual({
      ok: false,
      reason: "owner_segment",
    });
    expect(
      v.value(setInstrumentSegment, { instrument: iid, segment: "gold", by: "agent" }),
    ).toEqual({
      changed: false,
    });
    expect(loadInstrument(read, iid)).toMatchObject({ segment: "gold", segmentBy: "owner" });
  });

  it("setManualValuation keeps one value per (instrument, date)", () => {
    const v = vault();
    const iid = storedInstrument(v);
    const read = v.store.read.bind(v.store);
    v.value(setManualValuation, {
      instrument: iid,
      asOf: "2026-02-01",
      unitValue: "99",
      currency: "PLN",
    });
    v.value(setManualValuation, {
      instrument: iid,
      asOf: "2026-02-01",
      unitValue: "0",
      currency: "PLN",
      note: "zamrozone",
    });
    v.value(setManualValuation, {
      instrument: iid,
      asOf: "2026-01-01",
      unitValue: "1",
      currency: "PLN",
    });
    expect(manualValuations(read).map((m) => [m.asOf, m.unitValue.toString(), m.note])).toEqual([
      ["2026-01-01", "1", null],
      ["2026-02-01", "0", "zamrozone"],
    ]);
    expect(manualValuations(read, [])).toEqual([]);
    expect(allInstruments(read).map((i) => i.id)).toEqual([iid]);
  });
});
