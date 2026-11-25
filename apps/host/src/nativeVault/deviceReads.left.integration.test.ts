// A paired device that removed its copy wrote `device.left` about itself before it wiped: the
// native vault's device list carries `leftAt` (this Mac's calendar day of the note) for that device,
// and nothing else changes (it stays trusted, not revoked, until the owner removes it with the words).
// Synthetic vault and devices only.

import { mintUlid } from "@cashu/store";
import { createOwnLogCodec, createSyncEngine, crypto, devices } from "@cashu/sync";
import {
  insecureTestGate,
  MemoryClockStore,
  MemorySink,
  MemoryTransport,
} from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { type NativeVaultFixture, nativeVaultFixture } from "../testing/nativeVaultFixture.js";

const fixtures: NativeVaultFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** The local calendar day of `ms`, computed independently of the host's formatter. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0")))
    .join("-");
}

it("lists leftAt for a device that wrote device.left, and keeps it a trusted vault device", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"], pairPeer: true });
  fixtures.push(fixture);
  const { provider } = fixture.vaultSource;
  const vault = fixture.vaultId;
  const peer = fixture.peerIdentity;
  if (peer === undefined) throw new Error("synthetic peer absent");
  const ring = await crypto.loadKeyring(provider.keyStore, provider.sodium, vault);
  if (!ring) throw new Error("synthetic keyring absent");
  const remote = new MemoryTransport();
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: { kind: "native", provider: { ...provider, remoteTransports: () => [remote] } },
  });
  try {
    const native = host.stores.vaults.get(vault)?.native;
    if (native === undefined) throw new Error("native vault not open");
    await native.sync();
    const before = await native.deviceList();
    if (before.kind !== "ready") throw new Error(`device list refused: ${before.code}`);
    expect(before.devices.find((d) => d.id === peer.deviceId)?.leftAt).toBeUndefined();

    // The peer notes that it removed its copy (a fixed synthetic moment: 14 Nov 2026, noon local).
    const at = new Date(2026, 10, 14, 12, 0, 0).getTime();
    const there = await createSyncEngine({
      vault,
      device: peer.deviceId,
      local: new MemoryTransport(),
      remotes: [remote],
      codec: createOwnLogCodec({ sodium: provider.sodium, ring, signer: peer }),
      gate: insecureTestGate(),
      sink: new MemorySink(),
      clockStore: new MemoryClockStore(),
    });
    await there.write([devices.buildDeviceLeft(peer, vault, mintUlid(Date.now()), at)]);
    await there.sync();
    await there.close();
    ring.wipe();

    await host.syncVault(vault);
    const after = await native.deviceList();
    if (after.kind !== "ready") throw new Error(`device list refused: ${after.code}`);
    const listed = after.devices.find((d) => d.id === peer.deviceId);
    expect(listed?.leftAt).toBe(localDay(at));
    expect(listed?.leftAt).toBe("2026-11-14");
    expect(listed?.trusted).toBe(true);
    expect(listed?.revoked).toBe(false);
    expect(after.devices.find((d) => d.id === native.device)?.leftAt).toBeUndefined();
    // Nothing but the note changed in the list.
    expect(after.devices.map(({ leftAt: _leftAt, ...rest }) => rest)).toEqual(before.devices);
    const { silentForMs: _a, ...leaderBefore } = before.leader;
    const { silentForMs: _b, ...leaderAfter } = after.leader;
    expect(leaderAfter).toEqual(leaderBefore);
  } finally {
    await host.stop();
  }
});
