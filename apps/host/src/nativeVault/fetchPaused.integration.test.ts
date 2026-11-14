// The G2 offline bound never refuses silently: the device list names the paused fetch
// (`leader.paused: "offline_too_long"`) exactly when the pinned leader is refused for it.
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";

const DAY = 24 * 60 * 60 * 1000;

it.each([
  ["no complete pull was ever recorded", undefined, true],
  ["the last complete pull is a day old", DAY, false],
  ["the last complete pull is 8 days old", 8 * DAY, true],
] as const)(
  "two devices that could lead, sync off: %s -> paused %s",
  async (_case, age, paused) => {
    const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
    const lastCompleteAt = age === undefined ? undefined : Date.now() - age;
    const host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource:
        lastCompleteAt === undefined
          ? fixture.vaultSource
          : {
              kind: "native" as const,
              provider: {
                ...fixture.vaultSource.provider,
                pullHistory: () => ({ lastCompleteAt }),
              },
            },
    });
    try {
      const vault = host.stores.vaults.get(fixture.vaultId);
      if (vault?.mode !== "native") throw new Error("synthetic native vault unavailable");
      await vault.native.sync();
      // The oracle: whether the lease itself lets this pinned leader fetch.
      expect(vault.native.canFetchPublicMarket()).toBe(!paused);
      const list = await vault.native.deviceList();
      if (list.kind !== "ready") throw new Error(`device list refused: ${list.code}`);
      expect(list.leader.device).toBe(vault.native.device);
      expect(list.leader.paused).toBe(paused ? "offline_too_long" : undefined);
    } finally {
      await host.stop();
      fixture.cleanup();
    }
  },
);

// One device only: nobody else can lead, so the bound does not apply and nothing is paused.
it("a single device with sync off is never paused", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (vault?.mode !== "native") throw new Error("synthetic native vault unavailable");
    await vault.native.sync();
    expect(vault.native.canFetchPublicMarket()).toBe(true);
    const list = await vault.native.deviceList();
    if (list.kind !== "ready") throw new Error(`device list refused: ${list.code}`);
    expect(list.leader.paused).toBeUndefined();
  } finally {
    await host.stop();
    fixture.cleanup();
  }
});
