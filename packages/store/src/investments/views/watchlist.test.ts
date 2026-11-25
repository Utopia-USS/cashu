import { parseDateTime } from "@cashu/domain";
import { asInstrumentId } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { watchRowFor } from "../queries/alerts.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { HOUSEHOLD_NOW, household } from "../testing/household.js";
import { det } from "../testing/kit.js";
import { readFacts } from "./facts.js";
import { portfolioAt } from "./portfolio.js";
import { compareReadRank, creationRanks, type StableReadRank } from "./stableOrder.js";

describe("watchlist anchor audit", () => {
  it("re-add and canonical merge preserve a row gid with its own applied added anchor", () => {
    const h = household();
    const targetWatch = det("watchlist_items", h.first);
    const events = [
      ...h.events,
      h.ev.make(
        "watchlist.added",
        targetWatch,
        { instrument: h.first, source: "user", stamps: { added_at: "2026-10-31T12:00:00Z" } },
        { wall: 100 },
      ),
      h.ev.make("watchlist.removed", h.watch, {}, { wall: 200 }),
      h.ev.make(
        "watchlist.added",
        h.watch,
        { instrument: h.watched, source: "agent", stamps: { added_at: "2026-10-31T12:00:00Z" } },
        { wall: 300 },
      ),
      h.ev.make(
        "watchlist.added",
        h.removedWatch,
        { instrument: h.saved, source: "user", stamps: { added_at: "2026-10-31T12:00:00Z" } },
        { wall: 350 },
      ),
      h.ev.make(
        "instrument.merged",
        h.watched,
        { source: h.watched, target: h.first, reason: "owner" },
        { wall: 400 },
      ),
    ];
    const result = assertOrderedDelivery(events, (store) => {
      const read = store.read.bind(store);
      const row = watchRowFor(read, h.first);
      expect(row?.gid).toBe(h.watch);
      expect(row?.source).toBe("agent");
      const anchors =
        store.read<StableReadRank>(`SELECT w.gid,e.hlc,e.eid FROM watchlist_items w JOIN event_log e ON e.gid=w.gid
        WHERE e.type='watchlist.added' AND e.state='applied' ORDER BY e.hlc COLLATE BINARY,e.eid COLLATE BINARY`);
      const anchor = anchors
        .filter((candidate) => candidate.gid === row?.gid)
        .sort(compareReadRank)[0];
      expect(anchor).toBeDefined();
      expect(creationRanks(read, "watchlist").get(h.watch)).toEqual(anchor);
      const loaded = portfolioAt(read, {
        vault: h.vault,
        asOf: "2026-10-31",
        prices: h.prices,
        strategy: h.strategy,
        lang: "en",
        instrumentIds: [asInstrumentId(h.saved)],
      });
      if (!loaded.ok) throw new Error(loaded.reason);
      const facts = readFacts(read, {
        portfolio: loaded.value,
        clock: {
          now: parseDateTime(HOUSEHOLD_NOW),
          today: "2026-10-31",
          timeZone: "Europe/Warsaw",
        },
      });
      expect(facts.watched.map((watched) => watched.id)).toEqual([h.watch, h.removedWatch]);
      return { rows: facts.watched, anchor };
    });
    expect(result.rows).toHaveLength(2);
  });
});
