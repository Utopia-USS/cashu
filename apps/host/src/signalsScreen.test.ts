import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, type market, priceBar } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { signalsScreenToday, snapshotWatchHits, snapshotWatchQuote } from "./signalsScreen.js";

describe("Signals owner action preparation", () => {
  it("uses the host's local calendar day across Warsaw midnight", () => {
    const instant = Date.UTC(2026, 9, 31, 23, 30);
    expect(new Date(instant).toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(signalsScreenToday(instant, "Europe/Warsaw")).toBe("2026-11-01");
  });
  it("retains remote hit and verifying bar answers when a provider mutates its objects", () => {
    const ownerMarket = {
      mic: "XWAR",
      yahooSuffix: ".WA",
      stooqSuffix: "",
      currency: "PLN",
      crypto: false,
      yahooDigits: null,
    };
    const ownerHit = {
      yahooSymbol: "SYN.WA",
      ticker: "SYN",
      name: "Synthetic",
      quoteType: "EQUITY",
      assetClass: "equity",
      exchangeLabel: "WSE",
      mic: "XWAR",
      currencyHint: "PLN",
      isin: null,
      source: "yahoo",
      market: ownerMarket,
    };
    const hits = snapshotWatchHits([ownerHit as unknown as market.SearchHit]);
    ownerHit.name = "Provider changed";
    ownerMarket.mic = "XETR";
    expect(hits[0]?.name).toBe("Synthetic");
    expect(hits[0]?.market?.mic).toBe("XWAR");

    const ownerBar = {
      ...priceBar({
        instrumentId: asInstrumentId("01800000-0000-8000-8000-000000000001"),
        date: "2026-10-31",
        close: D("10"),
        source: "yahoo",
        fetchedAt: parseDateTime("2026-10-31T12:00:00Z"),
      }),
    };
    const live = {
      symbol: "SYN.WA",
      currency: "PLN",
      instrumentType: "EQUITY",
      longName: "Synthetic",
      exchangeName: "WSE",
      bars: [ownerBar],
      splits: [],
      adjusted: [],
    } as unknown as market.ChartQuote;
    const quote = snapshotWatchQuote(live);
    ownerBar.close = D("99");
    expect(quote?.bars[0]?.close.toString()).toBe("10");
  });
});

import { defineCommand, ok, setModules } from "@cashu/store";
import type { NotificationQueue } from "@cashu/store/investments/local";
import { z } from "zod";
import { startLocalHost } from "./host.js";
import { signalsScreenActions } from "./signalsScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";
import { command } from "./testing/worker.js";

const openSyntheticSignal = defineCommand({
  id: "test.signalOpen",
  input: z.object({}),
  run(ctx) {
    const signal = ctx.newGid();
    ctx.emit("signal.opened", signal, {
      ruleId: "synthetic",
      kind: "synthetic",
      dedupKey: "synthetic",
      severity: "info",
      polarity: "neutral",
      message: "Synthetic signal",
      instrument: null,
      account: null,
      payload: {},
      run: null,
    });
    return ok({ signal });
  },
});

describe("Signals UI action on actual host stores", () => {
  it("keeps source-supported text fallback and refuses caller-owned resolution fields", async () => {
    const host = await startLocalHost({
      ...testHostOptions(tempDir()),
      launcher: false,
    });
    try {
      const vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("synthetic vault absent");
      await command(vault, setModules, { moduleIds: ["investments"] });
      const cap = { vault: vault.id, generation: "synthetic", isCurrent: () => true };
      const action = signalsScreenActions({
        bind: () => cap,
        now: () => Date.UTC(2026, 10, 3, 12),
        timeZone: () => "Europe/Warsaw",
      }).find((row) => row.id === "investments.signals.watch");
      if (!action) throw new Error("watch action absent");
      expect(
        await action.run(host.stores, vault.id, {
          target: { kind: "text", text: "SYN.WA" },
          source: "agent",
        }),
      ).toMatchObject({ status: "refused", reason: "invalid_input" });
      const result = await action.run(host.stores, vault.id, {
        target: { kind: "text", text: "SYN.WA" },
      });
      expect(result).toMatchObject({
        status: "completed",
        value: {
          ok: true,
          value: {
            cacheStatus: "not_applicable",
            warnings: expect.arrayContaining([
              expect.objectContaining({ code: "watchlist.guessed_price_symbol" }),
            ]),
          },
        },
      });
    } finally {
      await host.stop();
      cleanup();
    }
  });
  it("reports saved-but-cleanup-unconfirmed after a durable snooze and skips cleanup on undo", async () => {
    const host = await startLocalHost({
      ...testHostOptions(tempDir()),
      launcher: false,
    });
    try {
      const vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("synthetic vault absent");
      await command(vault, setModules, { moduleIds: ["investments"] });
      const { signal } = await command(vault, openSyntheticSignal, {});
      let cleanupCalls = 0;
      const notifications = {
        dropUnsent() {
          cleanupCalls++;
          throw new Error("synthetic cleanup failure");
        },
      } as unknown as NotificationQueue;
      const cap = {
        vault: vault.id,
        generation: "synthetic",
        isCurrent: () => true,
        notifications,
      };
      const action = signalsScreenActions({
        bind: () => cap,
        now: Date.now,
        timeZone: () => "Europe/Warsaw",
      }).find((row) => row.id === "investments.signals.snooze");
      if (!action) throw new Error("snooze action absent");
      const until = new Date(Date.now() + 86400_000).toISOString();
      expect(await action.run(host.stores, vault.id, { signal, until })).toMatchObject({
        status: "completed",
        value: { status: "saved_cleanup_unconfirmed", signal },
      });
      expect(cleanupCalls).toBe(1);
      expect(await action.run(host.stores, vault.id, { signal, until: null })).toMatchObject({
        status: "completed",
        value: { status: "saved", signal, dropped: null },
      });
      expect(cleanupCalls).toBe(1);
    } finally {
      await host.stop();
      cleanup();
    }
  });
});
