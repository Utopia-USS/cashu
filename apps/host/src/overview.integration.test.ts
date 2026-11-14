import { parseDateTime } from "@cashu/domain";
import { Currencies } from "@cashu/domain/investments";
import { decodeValue, type JsonValue } from "@cashu/host-protocol/store";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { investmentsLocal, openAccount, recordBalance, runCommand } from "@cashu/store";
import type { HeroView } from "@cashu/store/overview";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { cleanup, storeClient, tempDir, testHostOptions } from "./testing/harness.js";

afterEach(cleanup);

it("serves genuine overview, suppresses unchanged cache wakes and releases external listeners", async () => {
  const driver = openNodeSqlite(":memory:");
  const prices = new investmentsLocal.SqlPriceCache(driver);
  let listeners = 0;
  let wakes = 0;
  const changes = {
    subscribe(listener: () => void) {
      listeners++;
      const stop = prices.subscribe(() => {
        wakes++;
        listener();
      });
      return () => {
        listeners--;
        stop();
      };
    },
  };
  const dir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dir),
    overview: { prices, changes },
  });
  const client = await storeClient(dir);
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (vault === undefined) throw new Error("synthetic vault absent");
    for (const oldId of [
      "assets.addManualPosition",
      "assets.setVehicle",
      "assets.revalue",
      "assets.setDepreciation",
      "assets.setNote",
      "core.removeAccount",
      "core.restoreAccount",
    ]) {
      await expect(client.run(oldId, {}, { vault: vault.id })).rejects.toThrow("UnknownCommand");
    }
    const values = await client.subscribe("core.hero", vault.id, { today: "2026-10-01" });
    const summary = await client.subscribe("core.summary", vault.id, { today: "2026-10-01" });
    const series = await client.subscribe("core.netWorthSeries", vault.id, {
      today: "2026-10-01",
      lang: "en",
    });
    expect(summary.first).toMatchObject({ breakdown: { byType: {} } });
    expect(series.first).toMatchObject({ currency: "PLN", points: [] });
    const net = () =>
      (decodeValue(values.values.at(-1) as JsonValue) as HeroView).facts.net.toString();
    expect(net()).toBe("0.00");
    expect(listeners).toBe(3);
    const now = parseDateTime("2026-10-01T12:00:00Z");
    prices.batch(() => {
      prices.upsertRates("nbp", Currencies.EUR, [], now);
      prices.upsertRates("nbp", Currencies.USD, [], now);
    });
    expect(wakes).toBe(3);
    await client.run("core.renameProfile", { name: "Synthetic renamed" }, { vault: vault.id });
    expect(values.values).toHaveLength(1);
    expect(summary.values).toHaveLength(1);
    expect(series.values).toHaveLength(1);
    await vault.queue.run(() => {
      const opened = runCommand(
        vault.store,
        vault.writer,
        openAccount,
        { bank: "manual", type: "checking", currency: "PLN" },
        vault.env,
      );
      if (!opened.ok) throw new Error("synthetic account refused");
      const recorded = runCommand(
        vault.store,
        vault.writer,
        recordBalance,
        { account: opened.value.account, date: "2026-10-01", amount: "123.45" },
        vault.env,
      );
      expect(recorded.ok).toBe(true);
    });
    await expect.poll(net).toBe("123.45");
    expect(() =>
      prices.batch(() => {
        prices.upsertRates("nbp", Currencies.EUR, [], now);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(wakes).toBe(3);
    client.close();
    await expect.poll(() => listeners).toBe(0);
  } finally {
    client.close();
    await host.stop();
    driver.close();
  }
});
