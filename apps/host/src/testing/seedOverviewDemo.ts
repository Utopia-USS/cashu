/**
 * Explicit synthetic Electron acceptance setup (apps/desktop/e2e). Never a production data source
 * or launcher: synthetic-harness vaults in the isolated e2e temp root, no OS keychain, no network.
 *
 *   seedOverviewDemo.ts                 the dev demo (devDemo.ts) for E2E_TODAY plus the host's
 *                                       moduleless "Demo" vault, then the frozen expectations
 *   seedOverviewDemo.ts serve           serves it until SIGTERM; CASHU_E2E_SETTINGS / _RESEARCH /
 *                                       _SIGNALS / _REVIEW add the synthetic story of one spec;
 *                                       CASHU_E2E_WORKER binds an offline synthetic worker
 *   seedOverviewDemo.ts cross-profile   proves a vault-scoped command cannot reach another vault
 *
 * The expectations are what the TS store computes for the seed (the screens must show them), each
 * checked here against what the generator wrote (balances, property, loan) and across queries.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { budget, D, type Decimal, parseDateTime } from "@cashu/domain";
import { asProfileId } from "@cashu/domain/investments";
import { decodeValue, type JsonValue } from "@cashu/host-protocol/store";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { createProfile, investmentsLocal } from "@cashu/store";
import { combinedChanges } from "@cashu/store/investments/screen-sources";
import {
  checkedProfileSlug,
  DailyPriceLock,
  readStrategyFiles,
} from "@cashu/store/investments/services";
import type { OverviewLoan, ShellSummarySnapshot } from "@cashu/store/overview";
import { type LocalHost, startLocalHost } from "../host.js";
import { currentStrategyImages } from "../investmentScreenSources.js";
import { strategyPublicationPorts } from "../proposals/strategyFiles.js";
import { type ResearchScreenCapability, researchScreenSources } from "../researchScreen.js";
import { storeFiles } from "../stores.js";
import type { StrategyScreenCapability } from "../strategiesScreen.js";
import { privateWorkerState } from "../worker/state.js";
import { DEV_DEMO_MARKET_DB, devDemoFacts, devDemoProfiles, initDevDemo } from "./devDemo.js";
import { storeClient } from "./harness.js";
import { seedResearchDemo, syntheticResearchCapability } from "./researchDemo.js";
import { reviewDemoSources, seedReviewDemo } from "./reviewDemo.js";
import { seedSettingsDemo } from "./settingsDemo.js";
import { seedSignalsDemo } from "./signalsDemo.js";
import { syntheticStrategyDocuments } from "./strategyDocuments.js";
import { command } from "./worker.js";

/** The frozen expectations file in the e2e root (apps/desktop/e2e/demo-expectations.ts reads it). */
const DEMO_EXPECTATIONS = "demo-expectations.json";

function isolatedPaths() {
  const root = process.env.E2E_ROOT;
  const target = process.env.E2E_NATIVE_DATA_DIR;
  const today = process.env.E2E_TODAY;
  if (
    process.env.CASHU_TESTING !== "1" ||
    root === undefined ||
    target === undefined ||
    today === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(today)
  )
    throw new Error("explicit synthetic e2e paths are required");
  const canonical = realpathSync(root);
  const parent = relative(realpathSync(tmpdir()), canonical);
  if (
    parent.startsWith(`..${sep}`) ||
    parent === ".." ||
    !basename(canonical).startsWith("cashu-e2e-desktop-") ||
    resolve(target) !== join(canonical, "native-data")
  )
    throw new Error("the e2e seed requires its isolated Electron temp paths");
  const home = process.env.HOME;
  if (home === undefined || resolve(home) !== join(canonical, "home"))
    throw new Error("the e2e seed requires its isolated home");
  return { root: canonical, target, today, home };
}

interface DemoHostFlags {
  readonly settings: boolean;
  readonly research: boolean;
  readonly signals: boolean;
  readonly review: boolean;
  readonly worker: boolean;
}

interface DemoHost {
  readonly host: LocalHost;
  readonly vaults: ReadonlyMap<string, string>;
  stop(): Promise<void>;
}

/** The seed's host with the investments, overview, strategy (and per-spec story) sources wired. */
async function startDemoHost(target: string, home: string, flags: DemoHostFlags) {
  const cachePath = join(target, DEV_DEMO_MARKET_DB);
  if (!existsSync(cachePath)) throw new Error("synthetic e2e price cache is absent");
  const vaults = devDemoProfiles(target);
  const anna = vaults.get("demo-anna");
  if (anna === undefined) throw new Error("synthetic e2e vault is absent");
  const driver = openNodeSqlite(cachePath);
  const prices = new investmentsLocal.SqlPriceCache(driver);
  let alive = true;
  const capabilities = new Map<string, StrategyScreenCapability>();
  const strategySync = new Map<string, ReturnType<typeof strategyPublicationPorts>>();
  const researchCapabilities = new Map<string, ResearchScreenCapability>();
  const researchSources = flags.research
    ? researchScreenSources((vault) => researchCapabilities.get(vault) ?? null)
    : null;
  for (const [slug, vault] of vaults) {
    if (checkedProfileSlug(slug) === null) throw new Error("invalid synthetic profile segment");
    const path = join(target, "profiles", slug);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const directory = realpathSync(path);
    strategySync.set(
      vault,
      strategyPublicationPorts({
        vault,
        privateRoot: directory,
        directory,
        isCurrent: () => alive,
      }),
    );
    capabilities.set(
      vault,
      await syntheticStrategyDocuments({
        root: realpathSync(path),
        vault,
        generation: randomUUID(),
        isCurrent: () => alive,
      }),
    );
  }
  const images = currentStrategyImages((vault, generation) => {
    const cap = capabilities.get(vault);
    return cap?.generation === generation && cap.isCurrent();
  });
  const currentVaultOf = (read: <R>(sql: string) => R[]) =>
    read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
  const host = await startLocalHost({
    dataDir: target,
    vaultSource: { kind: "synthetic-harness" },
    home,
    launcher: false,
    strategyImages: images,
    strategies: { bind: (vault) => capabilities.get(vault) ?? null },
    ...(researchSources === null ? {} : { research: researchSources }),
    ...(flags.review
      ? { review: reviewDemoSources(anna, new Date().toISOString().slice(0, 10)) }
      : {}),
    // An offline worker owning every job, its state in the data dir. The daily slot is the last
    // minute of the day, so only a forced run (`cashu worker run`) records job runs.
    ...(flags.worker
      ? {
          worker: (_context, _notifications, queue) => {
            const directory = join(target, "e2e-worker");
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            return {
              state: privateWorkerState(directory, () => alive),
              ownership: { isExclusive: () => true },
              authority: () => ({ isHolder: () => alive }),
              language: () => "pl",
              offline: true,
              schedule: { hour: 23, minute: 59 },
              investments: {
                prices,
                notifications: queue,
                dailyLock: new DailyPriceLock(),
                files: (vault) => capabilities.get(vault.id)?.files ?? null,
                strategySync: (vault) => strategySync.get(vault.id) ?? null,
              },
            };
          },
        }
      : {}),
    investments: {
      strategy: images.source,
      market: {
        changes: prices,
        current: (read) => {
          const vault = currentVaultOf(read);
          return vault !== undefined && capabilities.get(vault)?.isCurrent() ? { prices } : null;
        },
        newestRateDate: () => prices.newestFxDate(),
      },
    },
    overview: {
      prices,
      changes: combinedChanges(prices, images.source.changes),
      sources: {
        plannedContribution: (read) => {
          const strategy = images.source.current(read);
          return strategy.status !== "current"
            ? null
            : budget.plannedContribution(strategy.state.state, strategy.state.config);
        },
        investmentRequest: (read, context) => {
          const vault = currentVaultOf(read);
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
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      alive = false;
      researchSources?.close();
      await host.stop();
      driver.close();
    })();
    return stopped;
  };
  try {
    for (const [vault, cap] of capabilities) {
      if (!host.stores.vaults.has(vault)) throw new Error("synthetic strategy vault is absent");
      images.publish({
        vault,
        generation: cap.generation,
        revision: randomUUID(),
        files: await readStrategyFiles(cap.files),
      });
    }
    const opened = host.stores.vaults.get(anna);
    if (opened === undefined) throw new Error("synthetic e2e vault did not open");
    const cap = capabilities.get(anna);
    if (flags.settings && cap !== undefined)
      await seedSettingsDemo(opened, await readStrategyFiles(cap.files));
    if (flags.research) {
      const selected = await seedResearchDemo(opened);
      researchCapabilities.set(
        anna,
        syntheticResearchCapability(
          anna,
          randomUUID(),
          () => alive,
          join(target, "profiles", "demo-anna"),
          selected.symbol,
        ),
      );
      researchSources?.changed();
    }
    if (flags.signals) await seedSignalsDemo(opened, new Date().toISOString().slice(0, 10));
    if (flags.review) await seedReviewDemo(opened, prices, new Date().toISOString().slice(0, 10));
  } catch (error) {
    await stop();
    throw error;
  }
  return { host, vaults, stop } satisfies DemoHost;
}

// ---------------------------------------------------------------------------------- init

/** The host's moduleless bootstrap profile, kept beside the demo to prove module boundaries. */
async function addBootstrapVault(target: string, home: string): Promise<void> {
  const files = storeFiles(target);
  const vault = randomBytes(16).toString("hex");
  writeFileSync(join(files.vaultDir, `${vault}.salt`), `${randomBytes(32).toString("hex")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(join(files.vaultDir, `${vault}.db`), "", { mode: 0o600, flag: "wx" });
  const host = await startLocalHost({
    dataDir: target,
    vaultSource: { kind: "synthetic-harness" },
    home,
    launcher: false,
    ported: [],
  });
  try {
    const opened = host.stores.vaults.get(vault);
    if (opened === undefined) throw new Error("the bootstrap vault did not open");
    await command(opened, createProfile, { slug: "demo", name: "Demo" });
  } finally {
    await host.stop();
  }
}

const text = (value: Decimal) => value.toString();

/** Throws unless the store value equals the generator's (decimal equality, not formatting). */
function agree(what: string, store: Decimal | null | undefined, generated: string): void {
  if (store === null || store === undefined || !store.eq(D(generated)))
    throw new Error(`the store disagrees with the generator: ${what}`);
}

/** The fields of `core.overviewAccounts` / `core.overviewAssets` rows the expectations keep. */
interface AccountLine {
  readonly type: string;
  readonly bank: string;
  readonly currency: string;
  readonly amount: Decimal | null;
  readonly liability: boolean;
}

type Query = <T>(query: string, vault: string, args?: JsonValue) => Promise<T>;

async function expectations(query: Query, vaults: ReadonlyMap<string, string>, today: string) {
  const anna = vaults.get("demo-anna");
  const piotr = vaults.get("demo-piotr");
  if (anna === undefined || piotr === undefined) throw new Error("synthetic vault pair is absent");
  const facts = new Map(devDemoFacts(today).map((f) => [f.slug, f]));
  const annaFacts = facts.get("demo-anna");
  const piotrFacts = facts.get("demo-piotr");
  if (
    annaFacts === undefined ||
    annaFacts.property === null ||
    annaFacts.loan === null ||
    piotrFacts === undefined
  )
    throw new Error("synthetic generator facts are absent");

  const summary = (vault: string) => query<ShellSummarySnapshot>("core.summary", vault, { today });
  const annaSummary = await summary(anna);
  const piotrSummary = await summary(piotr);
  const base = annaSummary.breakdown.currency;

  const accounts = await query<AccountLine[]>("core.overviewAccounts", anna, { today });
  const line = (type: string, currency: string) =>
    accounts.find((row) => row.type === type && row.currency === currency)?.amount;
  agree("anna checking balance", line("checking", "PLN"), annaFacts.checking);
  agree("anna savings balance", line("savings", "PLN"), annaFacts.savings);
  if (annaFacts.eur !== null) agree("anna EUR balance", line("checking", "EUR"), annaFacts.eur);
  const signed = accounts.reduce(
    (sum, row) =>
      row.currency !== base || row.amount === null
        ? sum
        : row.liability
          ? sum.sub(row.amount.abs())
          : sum.add(row.amount),
    D("0"),
  );
  agree("anna net worth vs its lines", annaSummary.breakdown.net, text(signed));
  agree(
    "piotr net worth",
    piotrSummary.breakdown.net,
    text(D(piotrFacts.checking).add(D(piotrFacts.savings))),
  );

  const assets = await query<(AccountLine & { kind: string })[]>("core.overviewAssets", anna, {
    today,
  });
  agree("anna property", assets[0]?.amount, annaFacts.property);

  const loans = await query<OverviewLoan[]>("core.overviewLoans", anna, { today });
  if (loans.length !== 1 || loans[0]?.name !== annaFacts.loan.name)
    throw new Error("the store disagrees with the generator: anna loan");
  agree("anna loan installment", loans[0]?.monthlyPayment, annaFacts.loan.installment);

  const monthOf = (day: string) => day.slice(0, 7);
  const previous = new Date(`${today.slice(0, 8)}01T12:00:00Z`);
  previous.setUTCDate(0);
  const months: Record<string, unknown> = {};
  for (const month of [monthOf(today), previous.toISOString().slice(0, 7)]) {
    const close = await query<{
      close: {
        baseCurrency: string;
        currencies: { currency: string; income: Decimal; spending: Decimal; surplus: Decimal }[];
      };
    }>("budget.desktopMonthClose", anna, { today, month, lang: "pl" });
    const row =
      close.close.currencies.find((r) => r.currency === close.close.baseCurrency) ??
      close.close.currencies[0];
    if (row === undefined) throw new Error("synthetic month close is empty");
    months[month] = {
      currency: row.currency,
      income: text(row.income),
      spending: text(row.spending),
      surplus: text(row.surplus),
    };
  }

  const investments = await query<{ status: string; value?: Decimal; currency?: string }>(
    "core.overviewInvestments",
    anna,
    { today, lang: "pl" },
  );
  if (investments.status !== "available" || investments.value === undefined)
    throw new Error("synthetic investments widget is unavailable");
  const portfolio = await query<{
    status: string;
    positions?: {
      total: Decimal;
      base_currency: string;
      positions: { instrument: { label: string } }[];
    };
  }>("investments.desktop.portfolio", anna, {
    today,
    now: new Date().toISOString(),
    timeZone: "Europe/Warsaw",
    lang: "pl",
  });
  const held = portfolio.positions;
  if (portfolio.status !== "ready" || held === undefined || held.positions.length === 0)
    throw new Error("synthetic portfolio is not ready");
  const series = await query<{ currency: string; points: { value: Decimal }[] }>(
    "core.netWorthSeries",
    anna,
    { today, lang: "pl", currency: base, granularity: "monthly", scope: "total" },
  );
  const last = series.points.at(-1)?.value;
  if (last === undefined) throw new Error("synthetic net worth series is empty");
  agree("anna series end vs net worth", last, text(annaSummary.breakdown.net));

  return {
    today,
    anna: {
      net: text(annaSummary.breakdown.net),
      currency: base,
      currencies: Object.keys(annaSummary.networth),
      months,
      accounts: accounts.map((row) => ({
        type: row.type,
        bank: row.bank,
        amount: row.amount === null ? null : text(row.amount),
        currency: row.currency,
      })),
      assets: assets.map((row) => ({
        kind: row.kind,
        amount: row.amount === null ? null : text(row.amount),
        currency: row.currency,
      })),
      loans: loans.map((row) => ({
        name: row.name,
        currency: row.currency,
        outstanding: text(row.outstanding),
        monthlyPayment: text(row.monthlyPayment),
      })),
      investments: { value: text(investments.value), currency: investments.currency ?? base },
      portfolio: {
        total: text(held.total),
        currency: held.base_currency,
        firstLabel: held.positions[0]?.instrument.label ?? "",
      },
      seriesEnd: { value: text(last), currency: series.currency },
    },
    piotr: { net: text(piotrSummary.breakdown.net), currency: piotrSummary.breakdown.currency },
  };
}

async function init(root: string, target: string, today: string, home: string): Promise<void> {
  if (existsSync(target)) throw new Error("synthetic e2e target must be new");
  await initDevDemo(target, { home, today });
  await addBootstrapVault(target, home);
  const served = await startDemoHost(target, home, {
    settings: false,
    research: false,
    signals: false,
    review: false,
    worker: false,
  });
  try {
    const client = await storeClient(target);
    try {
      const query: Query = async (name, vault, args = null) =>
        decodeValue((await client.subscribe(name, vault, args)).first as JsonValue) as never;
      const expected = await expectations(query, served.vaults, today);
      writeFileSync(join(root, DEMO_EXPECTATIONS), `${JSON.stringify(expected, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      client.close();
    }
  } finally {
    await served.stop();
  }
  process.stdout.write(`synthetic e2e demo: ${served.vaults.size + 1} vaults\n`);
}

// ---------------------------------------------------------------------------------- modes

async function crossProfile(target: string): Promise<void> {
  const vaults = devDemoProfiles(target);
  const owner = vaults.get("demo-anna");
  const other = vaults.get("demo-piotr");
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
}

async function serve(target: string, home: string): Promise<void> {
  const served = await startDemoHost(target, home, {
    settings: process.env.CASHU_E2E_SETTINGS === "1",
    research: process.env.CASHU_E2E_RESEARCH === "1",
    signals: process.env.CASHU_E2E_SIGNALS === "1",
    review: process.env.CASHU_E2E_REVIEW === "1",
    worker: process.env.CASHU_E2E_WORKER === "1",
  });
  const ready = join(target, "overview-ready");
  const readyStage = join(target, `overview-ready-${process.pid}`);
  writeFileSync(readyStage, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  renameSync(readyStage, ready);
  const stop = () => {
    rmSync(ready, { force: true });
    void served.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await served.host.exit;
  rmSync(ready, { force: true });
  await served.stop();
}

const { root, target, today, home } = isolatedPaths();
const mode = process.argv[2];
if (mode === "serve") await serve(target, home);
else if (mode === "cross-profile") await crossProfile(target);
else if (mode === undefined) await init(root, target, today, home);
else throw new Error("usage: seedOverviewDemo.ts [serve | cross-profile]");
