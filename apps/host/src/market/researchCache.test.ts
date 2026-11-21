import { D, parseDateTime } from "@cashu/domain";
import { Currencies, market } from "@cashu/domain/investments";
import * as macro from "@cashu/domain/investments/macro";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { SqlCalendarCache, SqlPriceCache } from "@cashu/store/investments/local";
import { expect, it } from "vitest";
import type { OpenVault } from "../stores.js";
import { cachedResearchSources } from "./researchCache.js";

it("publishes valid cached calendar and macro per current vault, then invalidates market changes", () => {
  const driver = openNodeSqlite(":memory:");
  try {
    const prices = new SqlPriceCache(driver);
    const calendar = new SqlCalendarCache(driver);
    const id = "synthetic-vault";
    let current = true;
    const authority = { vault: id, generation: "synthetic-generation", isCurrent: () => current };
    const vault = {
      id,
      mode: "native",
      native: { workspaceAuthority: () => authority },
    } as OpenVault;
    const sources = cachedResearchSources({
      prices,
      calendar,
      vaults: new Map([[id, vault]]),
      isCurrent: () => current,
    });
    const read = ((sql: string) =>
      sql === "SELECT gid FROM profiles" ? [{ gid: id }] : []) as never;
    try {
      expect(sources.sources.calendar?.current(read)).toMatchObject({
        status: "unavailable",
        reason: "source_unbound",
      });
      calendar.restoreBytes(
        new TextEncoder().encode(
          JSON.stringify({
            fetched_at: null,
            from: "2026-11-01",
            to: "2026-11-08",
            macro: [{ date: "2026-11-02", time: "99:99", country: "US", title: "Synthetic" }],
            earnings: [],
            errors: [],
          }),
        ),
      );
      expect(sources.sources.calendar?.current(read)).toMatchObject({
        status: "unavailable",
        reason: "source_unbound",
      });
      calendar.restoreBytes(new TextEncoder().encode("{invalid"));
      expect(sources.sources.calendar?.current(read)).toMatchObject({
        status: "unavailable",
        reason: "source_unbound",
      });
      calendar.restoreBytes(
        new TextEncoder().encode(
          JSON.stringify({
            fetched_at: null,
            from: "2026-11-01",
            to: "2026-11-08",
            macro: [],
            earnings: [],
            errors: [],
          }),
        ),
      );
      expect(sources.sources.calendar?.current(read)).toMatchObject({
        status: "current",
        value: { vault: id },
      });
      let changes = 0;
      const stop = sources.sources.macro?.changes.subscribe(() => changes++);
      prices.upsertRates(
        "nbp",
        Currencies.USD,
        [{ date: "2026-11-01", rate: D("4"), fetchedAt: null }],
        parseDateTime("2026-11-01T12:00:00Z"),
      );
      expect(changes).toBe(1);
      calendar.restoreBytes(
        new TextEncoder().encode(
          JSON.stringify({
            fetched_at: null,
            from: "2026-11-02",
            to: "2026-11-09",
            macro: [],
            earnings: [],
            errors: [],
          }),
        ),
      );
      expect(changes).toBe(2);
      expect(sources.sources.macro?.current(read)).toMatchObject({
        status: "current",
        value: { vault: id },
      });
      prices.applyMacroReport(
        {
          asOf: "2026-11-01",
          series: [
            {
              series: macro.SERIES_KEYS[0] ?? "acwi",
              symbol: "SYNTH",
              status: market.FetchStatus.OK,
              start: "2026-10-31",
              end: "2026-11-01",
              closes: [["2026-11-01", D("12")]],
              source: "yahoo",
              message: null,
              adjusted: false,
            },
          ],
        },
        parseDateTime("2026-11-01T12:00:00Z"),
      );
      expect(changes).toBe(3);
      expect(sources.sources.macro?.current(read)).toMatchObject({ status: "current" });
      expect(prices.macroBars(macro.SERIES_KEYS[0] ?? "acwi")[0]?.close.toString()).toBe("12");
      stop?.();
      current = false;
      expect(sources.sources.calendar?.current(read)).toMatchObject({
        status: "unavailable",
        reason: "capability_unavailable",
      });
    } finally {
      sources.close();
    }
  } finally {
    driver.close();
  }
});
