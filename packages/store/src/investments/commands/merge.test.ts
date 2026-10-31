// Merging two instruments on the in-memory store. Translates Python
// tests/investments/persistence/test_instrument_merge.py at the store level: every reference follows
// the target, the source row is gone, renames between the pair are dropped, signal keys follow the
// target; different ISINs or currencies and the same / a missing instrument are refused; the
// preview (dry run) writes nothing. The CLI backup test is HTTP / CLI bound (S39). Where the fold's
// LWW precedence differs from Python's target-first rules (lead R-2, S25 R-S5) the test says so.
import { describe, expect, it } from "vitest";
import { watchlist } from "../queries/alerts.js";
import { loadInstrument, vaultInstrumentGids } from "../queries/instruments.js";
import { theses } from "../queries/journal.js";
import { openSignals, signalByGid } from "../queries/signals.js";
import { renames } from "../queries/transactions.js";
import { classifyInstrument, createInstrument, setInstrumentSegment } from "./instruments.js";
import { createThesis } from "./journal.js";
import { mergeInstruments, mergePreview } from "./merge.js";
import { applyRaw, raw, rawGid, type Vault, vault } from "./testing/fixtures.js";

const ISIN = "US0000000001";

function instrument(v: Vault, name: string, opts: Record<string, unknown>) {
  return v.value(createInstrument, { name, currency: "USD", assetClass: "equity", ...opts }).gid;
}

/** Python fixture `pair`: an ISIN-only stub (source) and a ticker instrument (target). */
function pair() {
  const v = vault();
  const source = instrument(v, "Przyklad Corp", { isin: ISIN, assetClass: "other" });
  const target = instrument(v, "Przyklad Corp", {
    symbol: "XMPL",
    aliases: [{ namespace: "yahoo", value: "XMPL" }],
  });
  applyRaw(v, [
    raw.watchAdded(v, source, { note: "powod z ISIN", tags: ["a"] }),
    raw.watchRemoved(v, source),
    raw.watchAdded(v, target, { tags: ["b"] }),
    raw.noteAdded(rawGid(1), source),
    raw.alertCreated(rawGid(2), source),
  ]);
  v.value(createThesis, {
    instrument: source,
    entryType: "sentiment_correction",
    thesis: "Stara teza",
  });
  v.value(createThesis, {
    instrument: target,
    entryType: "sentiment_correction",
    thesis: "Nowa teza",
  });
  v.value(classifyInstrument, {
    instrument: source,
    assetClass: "other",
    name: "Moja nazwa",
    reviewed: false,
  });
  v.value(setInstrumentSegment, { instrument: target, segment: "software", by: "owner" });
  return { v, source, target, read: v.store.read.bind(v.store) };
}

describe("mergeInstruments", () => {
  it("moves everything to the target and drops the source row", () => {
    const { v, source, target, read } = pair();
    const plan = v.value(mergeInstruments, { source, target });
    expect(plan.moved).toMatchObject({
      "inv_theses.instrument_id": 1,
      "research_notes.instrument_id": 1,
      "alerts.instrument_id": 1,
      "watchlist_items.instrument_id": 1,
      "inv_profile_instruments.instrument_id": 1,
    });
    expect(read<{ gid: string }>("SELECT gid FROM inv_instruments")).toEqual([{ gid: target }]);
    expect(loadInstrument(read, source)?.id).toBe(target); // the source gid still finds the row
    const t = loadInstrument(read, target, { shared: true });
    expect(t?.isin).toBe(ISIN); // the target takes the source's ISIN (it had none)
    expect(t?.aliases.map((a) => [a.namespace, a.value])).toEqual([
      ["isin", ISIN],
      ["yahoo", "XMPL"],
    ]);
    expect(
      theses(read, target)
        .map((x) => x.thesis)
        .sort(),
    ).toEqual(["Nowa teza", "Stara teza"]);
    const items = watchlist(read);
    expect(items).toHaveLength(1);
    expect(items[0]?.instrument).toBe(target);
    expect(items[0]?.note).toBe("powod z ISIN"); // the target's add carried no note
    expect(items[0]?.removedAt).toBeNull(); // the target's entry was live and stays so (N3)
    // Python joins the tags (["b", "a"]); the fold is LWW: the target's later add wins (R-S5).
    expect(items[0]?.tags).toEqual(["b"]);
    const seen = loadInstrument(read, target);
    expect(seen?.segment).toBe("software");
    // Python keeps the target's classification; the fold keeps the latest write per field (R-S5).
    expect(seen?.assetClass).toBe("other");
    expect(vaultInstrumentGids(read)).toEqual(new Set([target]));
  });

  it("the preview is the dry run: it reports and writes nothing", () => {
    const { source, target, read } = pair();
    const before = read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_instruments")[0]?.n;
    const preview = mergePreview(read, source, target);
    expect(preview.ok && Object.keys(preview.plan.moved).length).toBeGreaterThan(0);
    expect(read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_instruments")[0]?.n).toBe(before);
    expect(loadInstrument(read, target, { shared: true })?.isin).toBeNull();
  });

  it.each([
    [{ isin: "US0000000002" }, "different_isin"],
    [{ currency: "EUR" }, "different_currency"],
  ])("refuses different securities (%o)", (opts, reason) => {
    const v = vault();
    const source = instrument(v, "A", { isin: ISIN });
    const target = instrument(v, "B", {
      symbol: "B",
      aliases: [{ namespace: "x", value: "B" }],
      ...opts,
    });
    expect(v.run(mergeInstruments, { source, target })).toEqual({ ok: false, reason });
  });

  it("refuses the same instrument (also through a member gid) and a missing one", () => {
    const v = vault();
    const only = instrument(v, "A", { isin: ISIN });
    expect(v.run(mergeInstruments, { source: only, target: only })).toEqual({
      ok: false,
      reason: "same_instrument",
    });
    const missing = v.det("inv_instruments", ["isin:US0000000009"]);
    expect(v.run(mergeInstruments, { source: only, target: missing })).toEqual({
      ok: false,
      reason: "no_instrument",
    });
    const other = instrument(v, "A2", { symbol: "A", aliases: [{ namespace: "x", value: "A" }] });
    v.value(mergeInstruments, { source: other, target: only });
    expect(v.run(mergeInstruments, { source: other, target: only })).toEqual({
      ok: false,
      reason: "same_instrument",
    });
  });

  it("drops renames between the pair and collapses duplicates (test_renames_between_...)", () => {
    const v = vault();
    const source = instrument(v, "A", { isin: ISIN });
    const target = instrument(v, "A", { symbol: "A", aliases: [{ namespace: "x", value: "A" }] });
    const other = instrument(v, "Nastepca", {
      symbol: "N",
      aliases: [{ namespace: "x", value: "N" }],
    });
    const rename = (old: string, nw: string, day = "05") => ({
      type: "instrumentRename.recorded",
      gid: v.det("inv_instrument_renames", [`2026-03-${day}`, old, nw]),
      data: { date: `2026-03-${day}`, old, new: nw, note: null, batch: null },
    });
    applyRaw(v, [
      rename(source, target), // becomes X -> X
      rename(target, source), // becomes X -> X too
      rename(source, other), // duplicates the next one after the merge
      rename(target, other),
      rename(other, source, "06"), // moves
    ]);
    v.value(mergeInstruments, { source, target });
    expect(
      renames(v.store.read.bind(v.store)).map((r) => [r.oldInstrumentId, r.newInstrumentId]),
    ).toEqual([
      [target, other],
      [other, target],
    ]);
  });

  it("signal keys follow the target; a duplicate open key joins one episode", () => {
    const v = vault();
    const source = instrument(v, "A", { isin: ISIN });
    const target = instrument(v, "A", { symbol: "A", aliases: [{ namespace: "x", value: "A" }] });
    const [s1, s2, s3] = [rawGid(11), rawGid(12), rawGid(13)];
    applyRaw(v, [
      raw.signalOpened(s1, `plan:no_thesis|i:${source}`, { instrument: source }),
      raw.signalOpened(s2, `rule|i:${source}`, { instrument: source }),
      raw.signalOpened(s3, `rule|i:${target}`, { instrument: target }),
    ]);
    v.value(mergeInstruments, { source, target });
    const read = v.store.read.bind(v.store);
    const open = openSignals(read);
    expect(open.map((s) => s.dedupKey).sort()).toEqual([
      `plan:no_thesis|i:${target}`,
      `rule|i:${target}`,
    ]);
    expect(open.every((s) => s.instrument === target)).toBe(true);
    // Python resolves the source's duplicate; the fold keeps one open episode and maps both gids to it
    expect(signalByGid(read, s3)?.gid).toBe(signalByGid(read, s2)?.gid);
  });
});
