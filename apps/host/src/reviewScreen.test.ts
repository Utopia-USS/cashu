import { parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { decodeValue, encodeValue } from "@cashu/host-protocol/store";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { investmentsCommands as C, investmentsLocal, runCommand, setModules } from "@cashu/store";
import { strategySnapshot } from "@cashu/store/investments/screen-sources";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "./host.js";
import { reviewScreen } from "./reviewScreen.js";
import { cleanup, tempDir, testHostOptions } from "./testing/harness.js";
import { reviewDemoSources, seedReviewDemo } from "./testing/reviewDemo.js";

afterEach(cleanup);
afterEach(() => vi.unstubAllEnvs());
it("builds all seven cards from generated event facts and actual domain computations", async () => {
  vi.stubEnv("CASHU_E2E_REVIEW", "1");
  vi.stubEnv("CASHU_TESTING", "1");
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    python: null,
    now: () => Date.parse("2026-10-31T12:00:00Z"),
  });
  const driver = openNodeSqlite(":memory:");
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const prices = new investmentsLocal.SqlPriceCache(driver);
    const result = await vault.queue.run(() => {
      const enabled = runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["investments"] },
        vault.env,
      );
      if (!enabled.ok) throw new Error(enabled.reason);
      seedReviewDemo(vault, prices, "2026-10-31");
      const changes = { subscribe: () => () => {} };
      const sources = {
        ...reviewDemoSources(vault.id, "2026-10-31"),
        strategy: {
          changes,
          current: (read: Parameters<typeof strategySnapshot>[0]) =>
            strategySnapshot(read, {
              vault: vault.id,
              generation: "synthetic",
              revision: "one",
              files: {
                yaml: "version: 1\nbase_currency: PLN\n",
                md: "Synthetic strategy",
                readError: null,
              },
            }),
        },
        market: { changes, current: () => ({ prices }), newestRateDate: () => null },
        clock: {
          current: () => ({
            now: parseDateTime("2026-10-31T12:00:00Z"),
            timeZone: "Europe/Warsaw",
          }),
        },
      };
      return reviewScreen(sources).queries.screen.run(vault.store.read.bind(vault.store), {
        today: "2026-10-31",
        lang: "en",
        open: true,
      });
    });
    expect(result.status).toBe("current");
    if (result.status !== "current") throw new Error("generated Review was refused");
    expect(result.cards).toEqual([
      "world",
      "sectors",
      "positions",
      "events",
      "ideas",
      "calendar",
      "decide",
    ]);
    expect(result.movers.all.length).toBeGreaterThanOrEqual(60);
    expect(result.decide.items.some((item) => item.kind === "subject")).toBe(true);
    expect(result.calendar).toMatchObject({ status: "current", value: { stale: false } });
    expect(decodeValue(JSON.parse(JSON.stringify(encodeValue(result))))).toEqual(result);
  } finally {
    await host.stop();
    driver.close();
  }
});
it("encodes the actual tracked Review result with current files and market sources", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), python: null });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const result = await vault.queue.run(() => {
      const enabled = runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["investments"] },
        vault.env,
      );
      if (!enabled.ok) throw new Error(enabled.reason);
      const account = runCommand(
        vault.store,
        vault.writer,
        C.addBrokerageAccount,
        { name: "Synthetic", broker: "manual", currency: "PLN" },
        vault.env,
      );
      if (!account.ok) throw new Error(account.reason);
      const deposit = runCommand(
        vault.store,
        vault.writer,
        C.addManualTransaction,
        {
          account: account.value.account,
          type: "deposit",
          tradeDate: "2026-10-01",
          cashAmount: "100",
          currency: "PLN",
        },
        vault.env,
      );
      if (!deposit.ok) throw new Error(deposit.reason);
      const changes = { subscribe: () => () => {} };
      const sources = {
        strategy: {
          changes,
          current: (read: Parameters<typeof strategySnapshot>[0]) =>
            strategySnapshot(read, {
              vault: vault.id,
              generation: "synthetic",
              revision: "one",
              files: {
                yaml: "version: 1\nbase_currency: PLN\n",
                md: "Synthetic strategy",
                readError: null,
              },
            }),
        },
        market: {
          changes,
          current: () => ({ prices: new market.InMemoryPriceCache() }),
          newestRateDate: () => null,
        },
        clock: {
          current: () => ({
            now: parseDateTime("2026-10-31T12:00:00Z"),
            timeZone: "Europe/Warsaw",
          }),
        },
      };
      return reviewScreen(sources).queries.screen.run(vault.store.read.bind(vault.store), {
        today: "2026-10-31",
        lang: "en",
        open: true,
      });
    });
    expect(result.status).toBe("current");
    const transported = decodeValue(JSON.parse(JSON.stringify(encodeValue(result))));
    expect(transported).toEqual(result);
    expect(result).toMatchObject({
      hasData: true,
      sources: { macro: { status: "unavailable" } },
      calendar: { status: "unavailable" },
    });
  } finally {
    await host.stop();
  }
});
