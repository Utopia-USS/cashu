// Two native hosts of one vault converge through one fake relay: the creator Mac enables the relay
// (vault + admin membership), the paired peer's data dir has the switch on, and each host's own write
// reaches the other through the relay's triggers alone (push 2 s after the write, the 5-minute pull).
// Synthetic vault and devices; the fake is `demo-cashu`.
import { connectHost } from "@cashu/node-host";
import { renameProfile } from "@cashu/store";
import { createFakeFirebase } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import { runHostVaultCommand } from "../commands.js";
import { type LocalHost, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import {
  fakeRelayOptions,
  ManualRelayTimers,
  type PeerDataDir,
  peerDataDir,
  presetRelaySetting,
  until,
} from "../testing/relayFixture.js";
import { RELAY_PULL_INTERVAL_MS, RELAY_PUSH_DEBOUNCE_MS } from "./policy.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function profileName(host: LocalHost, vault: string): string | undefined {
  return host.stores.vaults
    .get(vault)
    ?.native?.store.read<{ name: string }>("SELECT name FROM profiles")[0]?.name;
}

async function rename(host: LocalHost, vault: string, name: string): Promise<void> {
  const opened = host.stores.vaults.get(vault);
  if (opened === undefined) throw new Error("vault not open");
  expect((await runHostVaultCommand(opened, renameProfile, { name }, `rename-${name}`)).kind).toBe(
    "completed",
  );
}

it("converges two hosts of one vault through the relay's push and pull triggers", async () => {
  const fixture: NativeVaultFixture = await nativeVaultFixture({
    modules: ["budget"],
    pairPeer: true,
  });
  cleanups.push(() => fixture.cleanup());
  const peer: PeerDataDir = await peerDataDir(fixture);
  cleanups.push(() => peer.cleanup());
  const vault = fixture.vaultId;
  const fake = createFakeFirebase();
  const timersA = new ManualRelayTimers();
  const timersB = new ManualRelayTimers();
  const relayA = fakeRelayOptions(fake, timersA);
  const relayB = fakeRelayOptions(fake, timersB);
  const startA = async () => {
    const host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      log: memoryLog(),
      vaultSource: fixture.vaultSource,
      relay: relayA,
    });
    cleanups.push(() => host.stop());
    return host;
  };

  // The creator switches the relay on (vault + admin membership); the handover reopens it.
  const first = await startA();
  const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "test" });
  expect(await ui.call("native.relay.enable", { vault })).toEqual({ kind: "done" });
  ui.close();
  expect(await first.exit).toBe(75);
  const a = await startA();
  timersA.advance(0);
  await until(() => a.relay.pending() === 0 && a.relay.status(vault).lastSyncAt !== undefined);

  // The peer's switch, as a completed pairing over the relay leaves it.
  presetRelaySetting(peer.dataDir, vault, {
    enabled: true,
    project: "demo-cashu",
    enabledAt: timersB.now(),
    memberUids: {},
  });
  const b = await startLocalHost({
    dataDir: peer.dataDir,
    home: peer.home,
    build: "test",
    launcher: false,
    log: memoryLog(),
    vaultSource: peer.vaultSource,
    relay: relayB,
  });
  cleanups.push(() => b.stop());
  timersB.advance(0);
  await until(() => b.relay.pending() === 0 && b.relay.status(vault).lastSyncAt !== undefined);
  expect(profileName(b, vault)).toBe("Synthetic");

  // A's write: pushed 2 s later; B pulls it on its 5-minute timer.
  await rename(a, vault, "Named on the creator");
  timersA.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => a.relay.pending() === 0);
  timersB.advance(RELAY_PULL_INTERVAL_MS);
  await until(() => b.relay.pending() === 0 && profileName(b, vault) === "Named on the creator");

  // B's write travels back the same way.
  await rename(b, vault, "Named on the peer");
  timersB.advance(RELAY_PUSH_DEBOUNCE_MS);
  await until(() => b.relay.pending() === 0);
  timersA.advance(RELAY_PULL_INTERVAL_MS);
  await until(() => a.relay.pending() === 0 && profileName(a, vault) === "Named on the peer");
  expect(profileName(b, vault)).toBe("Named on the peer");

  // Both devices' streams are at the relay, nothing else.
  const writers = new Set<string>();
  for (const [path, doc] of fake.documents(`vaults/${vault}/segments/`)) {
    if (path.includes("/chunks/")) continue;
    const device = doc.fields.device;
    if (device !== undefined && "stringValue" in device) writers.add(device.stringValue);
  }
  expect([...writers].sort()).toEqual(
    [fixture.vaultSource.provider.inventory[0]?.deviceId, peer.device].sort(),
  );
});
