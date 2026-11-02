import { parseDateTime } from "@cashu/domain";
import { Currencies } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import { applyRaw, raw, rawGid, stock, vault } from "../commands/testing/fixtures.js";
import { AS_OF, household } from "../performance/testing/household.js";
import { collectPriceNeeds } from "./priceNeeds.js";

it("collects actual held subjects and lot FX history without writing strategy versions", () => {
  const v = vault();
  const h = household(v);
  const before = v.store.read("SELECT * FROM inv_strategy_versions");
  const needs = collectPriceNeeds(
    v.store.read.bind(v.store),
    AS_OF,
    parseDateTime(`${AS_OF}T12:00:00+00:00`),
    Currencies.PLN,
  );
  expect([...needs.instruments.keys()]).toEqual([h.wrld]);
  expect(needs.currencies.has(Currencies.EUR)).toBe(true);
  expect(needs.fxHistoryFrom.get(Currencies.EUR)).toBe("2025-01-06");
  expect(v.store.read("SELECT * FROM inv_strategy_versions")).toEqual(before);
  v.store.close();
});
it("includes active watch/live-alert subjects, excluding removed, expired and muted entries", () => {
  const v = vault();
  household(v);
  const watched = stock(v, "WATCH", "PL0000000001");
  const live = stock(v, "LIVE", "PL0000000002");
  const removed = stock(v, "REMOVED", "PL0000000003");
  const expired = stock(v, "EXPIRED", "PL0000000004");
  const muted = stock(v, "MUTED", "PL0000000005");
  applyRaw(v, [
    raw.watchAdded(v, watched),
    raw.watchAdded(v, removed),
    raw.watchRemoved(v, removed),
    raw.alertCreated(rawGid(801), live),
    raw.alertCreated(rawGid(802), expired, {
      expiresAt: "2025-09-29T12:00:00Z",
    }),
    raw.alertCreated(rawGid(803), muted),
    { type: "alert.statusSet", gid: rawGid(803), data: { status: "muted", snoozedUntil: null } },
  ]);
  const needs = collectPriceNeeds(
    v.store.read.bind(v.store),
    AS_OF,
    parseDateTime(`${AS_OF}T12:00:00Z`),
    Currencies.PLN,
  );
  expect([...needs.watched.keys()].sort()).toEqual([watched, live].sort());
  v.store.close();
});
