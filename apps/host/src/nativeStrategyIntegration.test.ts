import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { storeClient } from "./testing/harness.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

it("serves desktop Strategies source and refresh action from a native vault without injected capabilities", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  const client = await storeClient(fixture.dataDir);
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    expect(vault?.native?.strategyDirectoryAuthority()).not.toBeNull();
    const screen = await client.subscribe("investments.strategies.screen", fixture.vaultId, {
      lang: "en",
      privacy: false,
      selection: null,
    });
    const refresh = () => client.action("investments.strategies.refresh", {}, fixture.vaultId);
    const action = await refresh();
    expect(action).toMatchObject({ status: "completed" });
    await expect.poll(() => (screen.values.at(-1) as { status?: string })?.status).toBe("current");
    const latest = screen.values.at(-1);
    expect(latest).toMatchObject({ status: "current", canInit: true });
    const revision = (latest as { revision: string }).revision;
    expect(revision).toBeTruthy();

    const initialized = await client.action(
      "investments.strategies.init",
      { revision },
      fixture.vaultId,
    );
    expect(initialized).toMatchObject({ status: "completed" });
    const initializedRevision = (initialized as { value?: { revision?: string } }).value?.revision;
    expect(initializedRevision).toBeTruthy();
    await expect
      .poll(() => (screen.values.at(-1) as { revision?: string })?.revision)
      .toBe(initializedRevision);

    const directory = join(fixture.dataDir, "vaults", fixture.vaultId, "strategy");
    renameSync(directory, `${directory}-old`);
    mkdirSync(directory, { mode: 0o700 });
    const renewed = await refresh();
    expect(renewed).toMatchObject({ status: "completed" });
    const renewedRevision = (renewed as { value?: { revision?: string } }).value?.revision;
    expect(renewedRevision).toBeTruthy();
    expect(renewedRevision).not.toBe(initializedRevision);
    await expect.poll(() => screen.values.length).toBeGreaterThan(1);
    await expect
      .poll(() => (screen.values.at(-1) as { revision?: string })?.revision)
      .toBe(renewedRevision);
  } finally {
    client.close();
    await host.stop();
    fixture.cleanup();
  }
});

it("prepares the strategy files for a fresh host read in incognito, so the portfolio is not left without them", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  const client = await storeClient(fixture.dataDir);
  try {
    // Incognito from the first read (the flag survives an app restart): the strategies screen itself
    // stays unavailable, but the host still reads the files the portfolio needs.
    const screen = await client.subscribe("investments.strategies.screen", fixture.vaultId, {
      lang: "en",
      privacy: true,
      selection: null,
    });
    expect(screen.values.at(-1)).toMatchObject({ status: "unavailable", reason: "privacy" });
    const portfolio = await client.subscribe("investments.desktop.portfolio", fixture.vaultId, {
      today: "2026-11-09",
      lang: "en",
      account: null,
      range: "1y",
    });
    await expect
      .poll(() => (portfolio.values.at(-1) as { reason?: string })?.reason)
      .not.toBe("current_files_unavailable");
  } finally {
    client.close();
    await host.stop();
    fixture.cleanup();
  }
});
