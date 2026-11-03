/** Explicit synthetic Electron acceptance setup. Never a production data source or launcher. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { budget, D, parseDateTime } from "@cashu/domain";
import { asProfileId, market, toCurrency } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, investmentsLocal, Store } from "@cashu/store";
import { GENESIS_CHUNK, genesis } from "@cashu/store/genesis";
import { combinedChanges } from "@cashu/store/investments/screen-sources";
import { checkedProfileSlug, readStrategyFiles } from "@cashu/store/investments/services";
import { assertUnchanged, copyRun, manifest, runFiles } from "../cli/genesis/copy.js";
import { initKeys, readKeys } from "../cli/genesis/keys.js";
import { startLocalHost } from "../host.js";
import { currentStrategyImages } from "../investmentScreenSources.js";
import { type ResearchScreenCapability, researchScreenSources } from "../researchScreen.js";
import { storeFiles } from "../stores.js";
import type { StrategyScreenCapability } from "../strategiesScreen.js";
import { storeClient } from "./harness.js";
import { seedResearchDemo, syntheticResearchCapability } from "./researchDemo.js";
import { reviewDemoSources, seedReviewDemo } from "./reviewDemo.js";
import { seedSettingsDemo } from "./settingsDemo.js";
import { seedSignalsDemo } from "./signalsDemo.js";
import { syntheticStrategyDocuments } from "./strategyDocuments.js";

function isolatedPaths() {
  const root = process.env.E2E_ROOT;
  const source = process.env.CASHU_DATA_DIR;
  const target = process.env.E2E_NATIVE_DATA_DIR;
  if (
    process.env.CASHU_TESTING !== "1" ||
    root === undefined ||
    source === undefined ||
    target === undefined
  )
    throw new Error("explicit synthetic overview paths are required");
  const canonical = realpathSync(root);
  const parent = relative(realpathSync(tmpdir()), canonical);
  if (
    parent.startsWith(`..${sep}`) ||
    parent === ".." ||
    !basename(canonical).startsWith("cashu-e2e-desktop-") ||
    realpathSync(source) !== join(canonical, "data") ||
    resolve(target) !== join(canonical, "native-data")
  )
    throw new Error("overview setup requires its isolated Electron temp paths");
  return { source, target };
}

const { source, target } = isolatedPaths();
const cachePath = join(target, "overview-demo-market.db");
if (process.argv[2] === "rename") {
  const client = await storeClient(target);
  try {
    const current = await client.subscribe("device.currentVault", "device");
    if (typeof current.first !== "string") throw new Error("synthetic current vault is absent");
    const result = await client.run(
      "core.renameProfile",
      { name: "Demo E2E" },
      { vault: current.first },
    );
    if (!result.ok) throw new Error("synthetic rename was refused");
  } finally {
    client.close();
  }
} else if (process.argv[2] === "cross-profile") {
  const keys = readKeys(join(target, "overview-demo-keys.json"));
  const owner = keys.get("demo-anna")?.vault;
  const other = keys.get("demo-piotr")?.vault;
  if (owner === undefined || other === undefined || owner === other)
    throw new Error("synthetic vault pair is absent");
  const client = await storeClient(target);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const before = await client.subscribe("core.overviewAssets", other, { today });
    const created = await client.run(
      "assets.createOverviewAsset",
      {
        name: "Synthetic drawer scope",
        type: "property",
        value: "1",
        currency: "PLN",
        onDate: today,
      },
      { vault: owner },
    );
    if (!created.ok) throw new Error("synthetic scoped asset create refused");
    const account = (created.value as { account?: unknown }).account;
    if (typeof account !== "string") throw new Error("synthetic asset identity absent");
    const crossed = await client.run(
      "assets.updateDetails",
      { account, value: "2", onDate: today },
      { vault: other },
    );
    if (crossed.ok || crossed.reason !== "no_asset")
      throw new Error("cross-profile asset edit was not refused");
    const after = await client.subscribe("core.overviewAssets", other, { today });
    if (JSON.stringify(before.first) !== JSON.stringify(after.first) || before.values.length !== 1)
      throw new Error("foreign vault view changed");
    process.stdout.write("scoped drawer commands: pass\n");
  } finally {
    client.close();
  }
} else if (process.argv[2] === "serve") {
  if (!existsSync(cachePath)) throw new Error("synthetic overview cache is absent");
  const driver = openNodeSqlite(cachePath);
  const prices = new investmentsLocal.SqlPriceCache(driver);
  const imported = readKeys(join(target, "overview-demo-keys.json"));
  const reviewVault = imported.get("demo-anna")?.vault;
  let alive = true;
  const capabilities = new Map<string, StrategyScreenCapability>();
  const researchCapabilities = new Map<string, ResearchScreenCapability>();
  const researchSources =
    process.env.CASHU_E2E_RESEARCH === "1"
      ? researchScreenSources((vault) => researchCapabilities.get(vault) ?? null)
      : null;
  for (const [slug, key] of imported) {
    if (checkedProfileSlug(slug) === null) throw new Error("invalid synthetic profile segment");
    const path = join(target, "profiles", slug);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    capabilities.set(
      key.vault,
      await syntheticStrategyDocuments({
        root: realpathSync(path),
        vault: key.vault,
        generation: randomUUID(),
        isCurrent: () => alive,
      }),
    );
  }
  const images = currentStrategyImages((vault, generation) => {
    const cap = capabilities.get(vault);
    return cap?.generation === generation && cap.isCurrent();
  });
  const host = await startLocalHost({
    dataDir: target,
    home: process.env.HOME,
    python: null,
    launcher: false,
    strategyImages: images,
    strategies: { bind: (vault) => capabilities.get(vault) ?? null },
    ...(researchSources === null ? {} : { research: researchSources }),
    ...(process.env.CASHU_E2E_REVIEW === "1" && reviewVault
      ? {
          review: reviewDemoSources(reviewVault, new Date().toISOString().slice(0, 10)),
        }
      : {}),
    investments: {
      strategy: images.source,
      market: {
        changes: prices,
        current: (read) => {
          const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
          return vault !== undefined && capabilities.get(vault)?.isCurrent() ? { prices } : null;
        },
        newestRateDate: () => prices.newestFxDate(),
      },
    },
    overview: {
      prices,
      changes: combinedChanges(prices, images.source.changes),
      legacyIdentity: (vault, slug) => imported.get(slug)?.vault === vault,
      sources: {
        plannedContribution: (read) => {
          const strategy = images.source.current(read);
          return strategy.status !== "current"
            ? null
            : budget.plannedContribution(strategy.state.state, strategy.state.config);
        },
        investmentRequest: (read, context) => {
          const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
          const strategy = images.source.current(read);
          if (vault === undefined || strategy.status !== "current" || context.prices === null)
            return null;
          return {
            vault: asProfileId(vault),
            asOf: context.today,
            lang: context.lang,
            strategy: strategy.state,
            prices: context.prices,
            forOwner: true,
            newestRateDate: prices.newestFxDate(),
            clock: {
              now: parseDateTime(new Date().toISOString()),
              today: context.today,
              timeZone: "Europe/Warsaw",
            },
          };
        },
      },
    },
  });
  for (const [vault, cap] of capabilities) {
    if (!host.stores.vaults.has(vault)) throw new Error("synthetic strategy vault is absent");
    images.publish({
      vault,
      generation: cap.generation,
      revision: randomUUID(),
      files: await readStrategyFiles(cap.files),
    });
  }
  if (process.env.CASHU_E2E_SETTINGS === "1") {
    const vault = imported.get("demo-anna")?.vault;
    const opened = vault === undefined ? undefined : host.stores.vaults.get(vault);
    const cap = vault === undefined ? undefined : capabilities.get(vault);
    if (!opened || !cap) throw new Error("synthetic settings vault is absent");
    await seedSettingsDemo(opened, await readStrategyFiles(cap.files));
  }
  if (process.env.CASHU_E2E_RESEARCH === "1") {
    const vault = imported.get("demo-anna")?.vault;
    const opened = vault === undefined ? undefined : host.stores.vaults.get(vault);
    if (vault === undefined || opened === undefined)
      throw new Error("synthetic research vault is absent");
    const selected = await seedResearchDemo(opened);
    researchCapabilities.set(
      vault,
      syntheticResearchCapability(
        vault,
        randomUUID(),
        () => alive,
        join(target, "profiles", "demo-anna"),
        selected.symbol,
      ),
    );
    researchSources?.changed();
  }
  if (process.env.CASHU_E2E_SIGNALS === "1") {
    const vault = imported.get("demo-anna")?.vault;
    const opened = vault === undefined ? undefined : host.stores.vaults.get(vault);
    if (opened === undefined) throw new Error("synthetic Signals vault is absent");
    await seedSignalsDemo(opened, new Date().toISOString().slice(0, 10));
  }
  if (process.env.CASHU_E2E_REVIEW === "1") {
    const vault = imported.get("demo-anna")?.vault;
    const opened = vault === undefined ? undefined : host.stores.vaults.get(vault);
    if (opened === undefined) throw new Error("synthetic review vault is absent");
    await seedReviewDemo(opened, prices, new Date().toISOString().slice(0, 10));
  }
  const ready = join(target, "overview-ready");
  const readyStage = join(target, `overview-ready-${process.pid}`);
  writeFileSync(readyStage, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  renameSync(readyStage, ready);
  process.once("SIGTERM", () => {
    alive = false;
    researchSources?.close();
    rmSync(ready, { force: true });
    void host.stop();
  });
  process.once("SIGINT", () => {
    alive = false;
    researchSources?.close();
    void host.stop();
  });
  await host.exit;
  rmSync(ready, { force: true });
  driver.close();
} else {
  if (existsSync(target)) throw new Error("synthetic overview target must be new");
  const before = manifest(source);
  copyRun(source, target);
  // The existing real synthetic host bootstrap creates its empty, moduleless Demo vault. Keep
  // it beside the two imported profiles to prove that profile/module boundaries drive the shell.
  const bootstrap = await startLocalHost({
    dataDir: target,
    home: process.env.HOME,
    python: null,
    launcher: false,
    ported: [],
  });
  await bootstrap.stop();
  const copy = openNodeSqlite(join(target, "cashu.db"), { readOnly: true });
  try {
    const profiles = copy.prepare("SELECT slug FROM profiles ORDER BY id").all<{ slug: string }>();
    const keys = initKeys(
      join(target, "overview-demo-keys.json"),
      profiles.map((profile) => profile.slug),
    );
    const exported = genesis({ driver: copy, files: runFiles(target) }, keys, {
      strict: true,
      now: Date.now(),
    });
    const files = storeFiles(target);
    mkdirSync(files.vaultDir, { recursive: true, mode: 0o700 });
    for (const vault of exported.vaults) {
      const key = keys.get(vault.slug);
      if (key === undefined) throw new Error("synthetic vault key is absent");
      writeFileSync(
        join(files.vaultDir, `${vault.vault}.salt`),
        `${Buffer.from(key.salt.bytes).toString("hex")}\n`,
        { mode: 0o600, flag: "wx" },
      );
      const path = join(files.vaultDir, `${vault.vault}.db`);
      writeFileSync(path, "", { mode: 0o600, flag: "wx" });
      const store = Store.open({
        driver: openNodeSqlite(path),
        vault: vault.vault,
        salt: key.salt,
        modules: builtinModules(),
      });
      try {
        for (let offset = 0; offset < vault.events.length; offset += GENESIS_CHUNK) {
          const result = store.applyWire({
            device: vault.device,
            events: vault.events.slice(offset, offset + GENESIS_CHUNK),
          });
          if (
            result.parked !== 0 ||
            result.suppressed !== 0 ||
            result.rejected.length !== 0 ||
            result.needsUpgrade
          )
            throw new Error("synthetic overview genesis fold refused");
        }
      } finally {
        store.close();
      }
    }
    writeFileSync(cachePath, "", { mode: 0o600, flag: "wx" });
    const cacheDriver = openNodeSqlite(cachePath);
    try {
      const cache = new investmentsLocal.SqlPriceCache(cacheDriver);
      const now = parseDateTime(new Date().toISOString());
      cache.batch(() => {
        for (const bar of copy
          .prepare(`SELECT a.namespace AS provider, a.value AS symbol, b.date, b.close,
          b.open, b.high, b.low, b.volume, b.currency FROM inv_price_bars b
          JOIN inv_instrument_aliases a ON a.instrument_id = b.instrument_id
            AND (a.namespace = b.source OR b.source = 'demo')
          WHERE a.namespace IN ('yahoo', 'stooq') ORDER BY b.id`)
          .all<{
            provider: string;
            symbol: string;
            date: string;
            close: string;
            open: string | null;
            high: string | null;
            low: string | null;
            volume: number | null;
            currency: string | null;
          }>()) {
          cache.upsertBars(
            market.marketSymbol(bar.provider, bar.symbol),
            [
              {
                date: bar.date,
                close: D(bar.close),
                open: bar.open === null ? null : D(bar.open),
                high: bar.high === null ? null : D(bar.high),
                low: bar.low === null ? null : D(bar.low),
                volume: bar.volume,
                currency: bar.currency === null ? null : toCurrency(bar.currency),
                fetchedAt: null,
              },
            ],
            now,
          );
        }
        // The generator's DemoSource supplies the same canonical facts behind Yahoo/Stooq/NBP
        // requests. Project that explicit synthetic provider into the cache's symbol-keyed port;
        // no network fetch, new price calculation or Python result is used.
        for (const rate of copy
          .prepare(
            "SELECT source, quote, date, rate FROM inv_fx_rates WHERE base = 'PLN' ORDER BY id",
          )
          .all<{ source: string; quote: string; date: string; rate: string }>())
          cache.upsertRates(
            rate.source === "demo" ? "nbp" : rate.source,
            toCurrency(rate.quote),
            [{ date: rate.date, rate: D(rate.rate), fetchedAt: null }],
            now,
          );
      });
    } finally {
      cacheDriver.close();
    }
    assertUnchanged(before, manifest(source));
    process.stdout.write(`native overview vaults: ${exported.vaults.length}\n`);
  } finally {
    copy.close();
  }
}
