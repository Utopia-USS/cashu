// A native vault used on ONE device: nothing else runs a sync pass (no paired peer sends a carrier
// request), so the production fetch paths must obtain the lease's pull evidence themselves. These
// tests never call `sync()` by hand; the market answers from a synthetic stub, never the network.
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { ruleRuns } from "@cashu/store/investments/queries";
import { afterEach, expect, it, vi } from "vitest";
import { mayObtainFetchAuthority, refreshFetchAuthority } from "../fetchAuthority.js";
import { startLocalHost } from "../host.js";
import { createProductionMarket, type ProductionMarket } from "../market/production.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { createProductionWorkerBindings } from "./production.js";

// The host's engine refuses its own log when the injected clock is far behind it, so the fixture
// stamps the creator log from this same clock instead of the wall clock.
const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** Synthetic NBP answers (one USD rate on the last requested day); anything else is a 404. */
function stubMarket() {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const range =
      /\/api\/exchangerates\/(rates\/A\/usd|tables\/A)\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\//.exec(
        url,
      );
    const day = range?.[3];
    const rate = { no: "212/A/NBP/2026", effectiveDate: day, mid: 4.0123 };
    const body =
      range === null
        ? null
        : range[1] === "tables/A"
          ? JSON.stringify([
              { ...rate, table: "A", rates: [{ currency: "dolar", code: "USD", mid: 4.0123 }] },
            ])
          : JSON.stringify({ table: "A", currency: "dolar", code: "USD", rates: [rate] });
    return {
      status: body === null ? 404 : 200,
      headers: { get: () => null },
      text: async () => body ?? "",
    };
  };
  return { urls, fetch };
}

const fxRequested = (urls: readonly string[]) =>
  urls.some((url) => url.includes("api.nbp.pl/api/exchangerates/"));

/** `denyLease` stands in for a device the lease does not name: the worker never holds the lease. */
async function singleDeviceHost(clock: () => number, options: { denyLease?: boolean } = {}) {
  const fixture = await nativeVaultFixture({ modules: ["investments"], now: clock });
  fixtures.push(fixture);
  const stub = stubMarket();
  let market: ProductionMarket | undefined;
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
    now: clock,
    marketFactory: (stores, isCurrent, now) => {
      market = createProductionMarket({
        stores,
        isCurrent,
        now,
        fetch: stub.fetch,
        sleep: async () => {},
      });
      return market;
    },
    // Production wiring (main.ts): the real native fetch lease and its pull refresh.
    worker: (context) => {
      if (!market) throw new Error("production market was not bound");
      return createProductionWorkerBindings(context, {
        dataDir: fixture.dataDir,
        assertAdmission() {},
        strategyDirectory: (vault) => vault.native?.strategyDirectoryAuthority() ?? null,
        canFetchPublicMarket: (vault) =>
          options.denyLease !== true && (vault.native?.canFetchPublicMarket() ?? false),
        refreshFetchAuthority,
        mayObtainFetchAuthority,
        market,
        language: () => "en",
      });
    },
  });
  const vault = host.stores.vaults.get(fixture.vaultId);
  if (vault?.mode !== "native" || !market) throw new Error("synthetic native vault absent");
  return { fixture, host, vault, market, stub };
}

/** One `cashu` command over the host's CLI socket: its exit and everything it printed. */
async function cli(fixture: NativeVaultFixture, argv: string[], lang = "en") {
  const connection = await connectHost({ dataDir: fixture.dataDir, role: "cli", build: "test" });
  try {
    const out: string[] = [];
    const answer = new Promise<unknown>((resolve, reject) => {
      connection.onFrame((frame: HostFrame) => {
        if (frame.t === "note" && frame.id === 1) out.push(JSON.stringify(frame.params));
        if (frame.t === "res" && frame.id === 1) {
          if (frame.outcome.ok) resolve(frame.outcome.result);
          else reject(new Error(frame.outcome.error.code));
        }
      });
    });
    const params: CliExecParams = {
      argv,
      cwd: fixture.dataDir,
      paths: { home: fixture.home },
      env: { CASHU_LANG: lang },
      tty: { stdin: false, stdout: false, stderr: false },
    };
    connection.send({ t: "req", id: 1, method: "cli.exec", params });
    return { result: await answer, out: out.join("\n") };
  } finally {
    connection.close();
  }
}

const dailyStatus = (host: Awaited<ReturnType<typeof singleDeviceHost>>["host"]) =>
  host.status().worker?.jobs.find((row) => row.job === "investments.daily")?.status;

it("runs the worker daily on a single-device vault and stores fresh market data", async () => {
  // Only the worker's start-up tick runs (its interval is faked); nothing calls sync() by hand.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { host, vault, market, stub } = await singleDeviceHost(() => NOW);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    expect(fxRequested(stub.urls)).toBe(true);
    expect(market.fxNewest()).not.toBeNull();
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(1);
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    expect(
      (host.status().worker?.unavailable ?? []).filter(
        (row) => row.code === "fetch_authority_unavailable",
      ),
    ).toEqual([]);
  } finally {
    await host.stop();
  }
});

it("runs `invest run` on a single-device vault whose pull evidence went stale", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let time = NOW;
  const { fixture, host, vault, stub } = await singleDeviceHost(() => time);
  try {
    await expect.poll(() => dailyStatus(host)).toBe("ok");
    // Two days later the start-up pull is stale and no tick runs: only the command can refresh it.
    time += 2 * DAY;
    stub.urls.splice(0);
    expect(vault.native.canFetchPublicMarket()).toBe(false);
    expect(vault.native.mayObtainFetchAuthority()).toBe(true);
    const { result, out } = await cli(fixture, ["-p", fixture.profileSlug, "invest", "run"]);
    expect(result, out).toEqual({ kind: "exit", code: 0 });
    expect(out).not.toContain("skipped");
    expect(fxRequested(stub.urls)).toBe(true);
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(2);
  } finally {
    await host.stop();
  }
});

it("prints why `invest run` skipped a profile, in English and Polish", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { fixture, host, vault } = await singleDeviceHost(() => NOW, { denyLease: true });
  try {
    await expect.poll(() => host.status().worker?.state).toBe("idle");
    const argv = ["-p", fixture.profileSlug, "invest", "run"];
    const en = await cli(fixture, argv, "en");
    expect(en.result, en.out).toEqual({ kind: "exit", code: 0 });
    // The console wraps long lines, so the reason code and the start of its text are checked.
    expect(en.out).toContain(
      `${fixture.profileSlug}: skipped (reason: fetch_authority_unavailable - this device may not`,
    );
    const pl = await cli(fixture, argv, "pl");
    expect(pl.result, pl.out).toEqual({ kind: "exit", code: 0 });
    expect(pl.out).toContain(
      `${fixture.profileSlug}: pominięto (powód: fetch_authority_unavailable - to urządzenie`,
    );
    expect(ruleRuns(vault.store.read.bind(vault.store))).toHaveLength(0);
  } finally {
    await host.stop();
  }
});
