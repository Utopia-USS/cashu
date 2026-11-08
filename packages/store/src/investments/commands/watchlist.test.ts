// The watchlist write side at the command level (soft model, F12): one row per instrument (remove is
// SOFT, an add restores the same row with note / tags kept unless given, M2), note / tags rules, the
// item limit, the reuse of a listing another instrument holds, and vault isolation. Resolution and network paths are in
// `services/watchlist.test.ts`. Synthetic data only.
import { describe, expect, it } from "vitest";
import { watchedItemFor, watchlist, watchlistItem, watchRowFor } from "../queries/alerts.js";
import { loadInstrument, vaultInstrumentGids } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { storedByYahoo, watchTargetInstrument } from "../queries/watchlist.js";
import { classifyInstrument, createThesis } from "./index.js";
import { applyRaw, otherVault, raw, rawGid, stock, type Vault, vault } from "./testing/fixtures.js";
import {
  addToWatchlist,
  MAX_ITEMS,
  removeFromWatchlist,
  updateWatchlistItem,
} from "./watchlist.js";

const readOf =
  (v: Vault): Read =>
  (sql, ...params) =>
    v.store.read(sql, ...params);

/** An instrument the vault references (its classification is an override row). */
function referenced(v: Vault, symbol: string, isin: string): string {
  const gid = stock(v, symbol, isin);
  v.value(classifyInstrument, { instrument: gid, sector: "Test" });
  return gid;
}

/** A planned new listing (`instrumentSpec` input) with a guessed Yahoo alias. */
function planned(symbol: string, yahoo: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${symbol} SA`,
    currency: "PLN",
    assetClass: "equity",
    symbol,
    mic: "XWAR",
    needsClassification: true,
    aliases: [{ namespace: "yahoo", value: yahoo, guessed: true }],
    ...extra,
  };
}

/** `count` instruments, each on the watchlist, in one raw batch (the limit tests). */
function watchMany(v: Vault, count: number) {
  const events = [];
  for (let n = 1; n <= count; n++) {
    const gid = rawGid(5000 + n);
    events.push({
      type: "instrument.created",
      gid,
      data: {
        name: `Spolka ${n}`,
        currency: "PLN",
        assetClass: "equity",
        symbol: `S${n}`,
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
    });
    events.push(raw.watchAdded(v, gid));
  }
  applyRaw(v, events);
}

describe("addToWatchlist", () => {
  it("remove keeps everything and an add restores the same row (command level)", () => {
    const v = vault();
    const read = readOf(v);
    const newco = referenced(v, "NEWCO", "PL0000000101");
    const added = v.value(addToWatchlist, {
      target: { instrument: newco },
      note: "moja notatka",
      tags: ["polska"],
    });
    expect(added).toMatchObject({ instrument: newco, restored: false, createdInstrument: false });
    v.value(createThesis, { instrument: newco, entryType: "trend", thesis: "Moja teza" });

    v.env.advance(60_000);
    expect(v.value(removeFromWatchlist, { item: added.item })).toEqual({ item: added.item });
    const row = watchRowFor(read, newco); // never deleted
    expect(row).toMatchObject({ gid: added.item, note: "moja notatka", tags: ["polska"] });
    expect(row?.removedAt).not.toBeNull();
    expect(watchlist(read)).toEqual([]);
    expect(watchedItemFor(read, newco)).toBeUndefined();
    expect(vaultInstrumentGids(read).has(newco)).toBe(true);
    expect(v.run(removeFromWatchlist, { item: added.item })).toEqual({
      ok: false,
      reason: "no_item",
    });
    expect(v.run(updateWatchlistItem, { item: added.item, note: "x" })).toEqual({
      ok: false,
      reason: "no_item",
    });

    // by instrument: the same row, note and tags kept, moved to the end, source = this adder
    const before = row?.addedAt ?? "";
    v.env.advance(60_000);
    const again = v.value(addToWatchlist, { target: { instrument: newco }, source: "agent" });
    expect(again).toMatchObject({
      item: added.item,
      restored: true,
      createdInstrument: false,
      previousNote: "moja notatka",
      note: "moja notatka",
      tags: ["polska"],
    });
    const live = watchlistItem(read, added.item);
    expect(live).toMatchObject({ note: "moja notatka", tags: ["polska"], source: "agent" });
    expect((live?.addedAt ?? "") > before).toBe(true);
    expect(live?.removedAt).toBeNull();
    expect(v.run(addToWatchlist, { target: { instrument: newco } })).toEqual({
      ok: false,
      reason: "already_watched",
    });
    // the caller's way to the item of an `already_watched` refusal
    const target = watchTargetInstrument(read, { instrument: newco });
    expect(target === undefined ? undefined : watchedItemFor(read, target)?.gid).toBe(added.item);

    // tags passed -> replaced, note kept
    v.value(removeFromWatchlist, { item: added.item });
    const tagged = v.value(addToWatchlist, { target: { stored: newco }, tags: ["nowe"] });
    expect(tagged).toMatchObject({ item: added.item, restored: true, note: "moja notatka" });
    expect(watchlistItem(read, added.item)?.tags).toEqual(["nowe"]);
    // a note passed -> replaced
    v.value(removeFromWatchlist, { item: added.item });
    v.value(addToWatchlist, { target: { stored: newco }, note: "nowa notatka" });
    expect(watchlistItem(read, added.item)?.note).toBe("nowa notatka");
    expect(v.store.read("SELECT COUNT(*) AS n FROM watchlist_items")).toEqual([{ n: 1 }]);
  });

  it("refuses an instrument the vault does not reference (instrument) or does not have (stored)", () => {
    const v = vault();
    const loose = stock(v, "LOOSE", "PL0000000102"); // stored, referenced by nothing
    expect(v.run(addToWatchlist, { target: { instrument: loose } })).toEqual({
      ok: false,
      reason: "no_instrument",
    });
    expect(v.value(addToWatchlist, { target: { stored: loose } }).instrument).toBe(loose);
    for (const target of [{ instrument: rawGid(1) }, { stored: rawGid(1) }]) {
      expect(v.run(addToWatchlist, { target })).toEqual({ ok: false, reason: "no_instrument" });
    }
  });

  it("post takes exactly one way to name the instrument", () => {
    const v = vault();
    const gid = stock(v, "ONE", "PL0000000103");
    for (const target of [{}, { instrument: gid, stored: gid }, { stored: gid, planned: {} }]) {
      expect(v.run(addToWatchlist, { target })).toEqual({ ok: false, reason: "invalid_input" });
    }
  });

  it("note and tags are cleaned and capped", () => {
    const v = vault();
    const a = stock(v, "AAA", "PL0000000104");
    const cases: [Record<string, unknown>, string][] = [
      [{ note: "x".repeat(1001) }, "note_too_long"],
      [{ note: " ".repeat(1001) }, "note_too_long"], // counted before stripping
      [{ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "too_many_tags"],
      [{ tags: ["y".repeat(41)] }, "tag_too_long"],
    ];
    for (const [extra, reason] of cases) {
      expect(v.run(addToWatchlist, { target: { stored: a }, ...extra })).toEqual({
        ok: false,
        reason,
      });
    }
    const added = v.value(addToWatchlist, {
      target: { stored: a },
      note: "   ",
      tags: [" b ", "", "  ", "b", "c", ...Array.from({ length: 10 }, () => "c")],
    });
    expect(added).toMatchObject({ note: null, tags: ["b", "c"] });
    expect(watchlistItem(readOf(v), added.item)).toMatchObject({ note: null, tags: ["b", "c"] });
  });

  it("a planned instrument is stored in the same batch; a listing another instrument holds is reused", () => {
    const v = vault();
    const read = readOf(v);
    const first = v.value(addToWatchlist, {
      target: { planned: planned("SYN", "SYN.WA"), yahooSymbol: "SYN.WA" },
    });
    expect(first.createdInstrument).toBe(true);
    expect(loadInstrument(read, first.instrument, { shared: true })).toMatchObject({
      symbol: "SYN",
      needsClassification: true,
      aliases: [{ namespace: "yahoo", value: "SYN.WA", guessed: true }],
    });
    expect(storedByYahoo(read, ["syn.wa"]).get("SYN.WA")).toBe(first.instrument);
    v.value(removeFromWatchlist, { item: first.item });
    // another instrument took the listing (any case) -> that one, created false
    const rival = v.value(addToWatchlist, {
      target: {
        planned: planned("SYN", "syn.wa", { isin: "PL0000000105", name: "Rival" }),
        yahooSymbol: "syn.wa",
      },
    });
    expect(rival).toMatchObject({
      instrument: first.instrument,
      createdInstrument: false,
      restored: true,
      item: first.item,
    });
    // without a Yahoo symbol the creation alias decides (`storeInstrument`)
    const isin = stock(v, "HELD", "PL0000000106");
    const held = v.value(addToWatchlist, {
      target: { planned: planned("HELD", "HELD.WA", { isin: "PL0000000106" }) },
    });
    expect(held).toMatchObject({ instrument: isin, createdInstrument: false, restored: false });
  });

  it("accept restores a removed row and undo removes it again (watchlist part)", () => {
    // research accept (S21b) adds with keepExistingNote: the owner's note stays, previousNote kept
    const v = vault();
    const gid = stock(v, "NEWCO", "PL0000000107");
    const own = v.value(addToWatchlist, {
      target: { stored: gid },
      note: "moja obserwacja",
      tags: ["x"],
    });
    v.value(removeFromWatchlist, { item: own.item });
    const accepted = v.value(addToWatchlist, {
      target: { stored: gid },
      note: "kandydat: Newco",
      keepExistingNote: true,
    });
    expect(accepted).toMatchObject({
      item: own.item,
      restored: true,
      previousNote: "moja obserwacja",
      note: "moja obserwacja",
      tags: ["x"],
    });
    v.value(removeFromWatchlist, { item: own.item }); // undo: back to removed, never deleted
    expect(watchRowFor(readOf(v), gid)).toMatchObject({ note: "moja obserwacja", tags: ["x"] });
  });

  it("accept of a removed row without a note and its undo (watchlist part)", () => {
    const v = vault();
    const gid = stock(v, "NEWCO", "PL0000000108");
    const own = v.value(addToWatchlist, { target: { stored: gid } });
    v.value(removeFromWatchlist, { item: own.item });
    const accepted = v.value(addToWatchlist, {
      target: { stored: gid },
      note: "kandydat: Newco",
      keepExistingNote: true,
    });
    expect(accepted).toMatchObject({ previousNote: null, note: "kandydat: Newco" });
    expect(watchlistItem(readOf(v), own.item)?.note).toBe("kandydat: Newco");
    // research undo (S21b) puts the previous note back and removes the row
    v.value(updateWatchlistItem, { item: own.item, note: "" });
    v.value(removeFromWatchlist, { item: own.item });
    expect(watchRowFor(readOf(v), gid)?.note).toBeNull();
  });

  it("max items counts active rows only", () => {
    const v = vault();
    watchMany(v, MAX_ITEMS - 2);
    const first = v.value(addToWatchlist, {
      target: { planned: planned("AAA", "AAA.WA"), yahooSymbol: "AAA.WA" },
    });
    v.value(addToWatchlist, {
      target: { planned: planned("BBB", "BBB.WA"), yahooSymbol: "BBB.WA" },
    });
    const ccc = { target: { planned: planned("CCC", "CCC.WA"), yahooSymbol: "CCC.WA" } };
    expect(v.run(addToWatchlist, ccc)).toEqual({ ok: false, reason: "watchlist_full" });
    v.value(removeFromWatchlist, { item: first.item });
    v.value(addToWatchlist, ccc); // the removed row does not count
    // restoring counts like adding
    expect(v.run(addToWatchlist, { target: { instrument: first.instrument } })).toEqual({
      ok: false,
      reason: "watchlist_full",
    });
  });
});

describe("updateWatchlistItem", () => {
  it("changes only the given fields; a blank note clears it; nothing given writes nothing", () => {
    const v = vault();
    const read = readOf(v);
    const gid = stock(v, "UPD", "PL0000000109");
    const item = v.value(addToWatchlist, { target: { stored: gid }, note: "a", tags: ["t"] }).item;
    expect(v.value(updateWatchlistItem, { item, note: " b " })).toEqual({
      item,
      note: "b",
      tags: ["t"],
    });
    expect(watchlistItem(read, item)).toMatchObject({ note: "b", tags: ["t"] });
    v.value(updateWatchlistItem, { item, tags: [" u ", "u", "w"] });
    expect(watchlistItem(read, item)).toMatchObject({ note: "b", tags: ["u", "w"] });
    v.value(updateWatchlistItem, { item, note: "  " });
    expect(watchlistItem(read, item)?.note).toBeNull();
    const out = v.run(updateWatchlistItem, { item, note: null });
    expect(out.ok && out.events).toEqual([]);
    expect(v.run(updateWatchlistItem, { item, tags: ["z".repeat(41)] })).toEqual({
      ok: false,
      reason: "tag_too_long",
    });
  });

  it("a removed or unknown item is no_item, checked before the fields", () => {
    const v = vault();
    const gid = stock(v, "GONE", "PL0000000110");
    const item = v.value(addToWatchlist, { target: { stored: gid } }).item;
    v.value(removeFromWatchlist, { item });
    for (const target of [item, rawGid(9)]) {
      expect(v.run(updateWatchlistItem, { item: target, note: "x".repeat(1001) })).toEqual({
        ok: false,
        reason: "no_item",
      });
      expect(v.run(removeFromWatchlist, { item: target })).toEqual({
        ok: false,
        reason: "no_item",
      });
    }
  });
});

describe("watchlist vault isolation", () => {
  it("another vault never sees the rows and refuses this vault's gids", () => {
    const v = vault();
    const other = otherVault();
    const gid = stock(v, "MINE", "PL0000000111");
    const item = v.value(addToWatchlist, { target: { stored: gid }, note: "moja" }).item;
    const otherRead = readOf(other);
    expect(watchlist(otherRead)).toEqual([]);
    expect(watchRowFor(otherRead, gid)).toBeUndefined();
    expect(other.run(removeFromWatchlist, { item })).toEqual({ ok: false, reason: "no_item" });
    expect(other.run(addToWatchlist, { target: { stored: gid } })).toEqual({
      ok: false,
      reason: "no_instrument",
    });
    expect(watchlist(readOf(v)).map((w) => w.gid)).toEqual([item]);
  });
});
