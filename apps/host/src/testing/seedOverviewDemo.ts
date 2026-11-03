/** Explicit synthetic Electron acceptance setup. Never a production data source or launcher. */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { budget, D, parseDateTime } from "@cashu/domain";
import { asProfileId, market, toCurrency } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, investmentsLocal, Store } from "@cashu/store";
import { GENESIS_CHUNK, genesis } from "@cashu/store/genesis";
import {
  checkedProfileSlug,
  loadStrategy,
  type StrategyState,
} from "@cashu/store/investments/services";
import { assertUnchanged, copyRun, manifest, runFiles } from "../cli/genesis/copy.js";
import { initKeys, readKeys } from "../cli/genesis/keys.js";
import { startLocalHost } from "../host.js";
import { storeFiles } from "../stores.js";
import { storeClient } from "./harness.js";

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
  const strategies = new Map<string, StrategyState>();
  const host = await startLocalHost({
    dataDir: target,
    home: process.env.HOME,
    python: null,
    launcher: false,
    overview: {
      prices,
      changes: prices,
      legacyIdentity: (vault, slug) => imported.get(slug)?.vault === vault,
      sources: {
        plannedContribution: (read) => {
          const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
          const strategy = vault === undefined ? null : (strategies.get(vault) ?? null);
          return strategy === null
            ? null
            : budget.plannedContribution(strategy.state, strategy.config);
        },
        investmentRequest: (read, context) => {
          const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
          const strategy = vault === undefined ? null : (strategies.get(vault) ?? null);
          if (vault === undefined || strategy === null || context.prices === null) return null;
          return {
            vault: asProfileId(vault),
            asOf: context.today,
            lang: context.lang,
            strategy,
            prices: context.prices,
            forOwner: true,
            newestRateDate: null,
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
  const copied = runFiles(target);
  for (const [slug, key] of imported) {
    if (checkedProfileSlug(slug) === null) throw new Error("invalid synthetic profile segment");
    const vault = host.stores.vaults.get(key.vault);
    if (vault === undefined) throw new Error("synthetic strategy vault is absent");
    strategies.set(
      key.vault,
      await loadStrategy(vault.store, {
        read: async (name) => {
          const bytes = copied.read(`profiles/${slug}/${name}`);
          return bytes === undefined
            ? null
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
                .decode(bytes)
                .replaceAll("\r\n", "\n")
                .replaceAll("\r", "\n");
        },
        write: async () => {
          throw new Error("synthetic strategy reader is read-only");
        },
        exists: async (name) => copied.read(`profiles/${slug}/${name}`) !== undefined,
      }),
    );
  }
  writeFileSync(join(target, "overview-ready"), "ok\n", { mode: 0o600, flag: "wx" });
  process.once("SIGTERM", () => {
    void host.stop();
  });
  process.once("SIGINT", () => {
    void host.stop();
  });
  await host.exit;
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
