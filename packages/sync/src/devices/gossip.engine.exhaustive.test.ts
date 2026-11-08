// The recovery-overflow case of the real-engine gossip tests: a few seconds of real crypto, so it runs in
// the exhaustive tier (vitest.tiers.ts) instead of competing for the 5 s budget under load.
import { describe, expect, it } from "vitest";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  recoveryIdentity,
  signHead,
} from "../crypto/index.js";
import { newEid, sodium } from "../testing/devices/testkit.js";
import { must, node, subjectOf } from "../testing/gossipEngine.js";
import { MemoryTransport } from "../testing/memory.js";
import { encodeEvidence } from "./gateState.js";
import { MAX_GOSSIP_HISTORY } from "./gossip.js";
import { acknowledgeRevocationPreview, previewRevocation } from "./revocationPolicy.js";

describe("real engine gossip emission (exhaustive)", () => {
  it("recovery revokes a genuine overflowing writer and preserves its fork evidence across restart", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const owner = createDeviceIdentity(sodium);
    const compromised = createDeviceIdentity(sodium);
    const vault = createVaultWithRecovery(sodium, recovery, owner);
    const remote = new MemoryTransport();
    const a = await node(
      owner,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(owner), vault.ring.vaultId),
      remote,
    );
    const b = await node(
      compromised,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(compromised), vault.ring.vaultId),
      remote,
    );
    await a.engine.write([a.intro()]);
    await b.engine.write([b.intro()]);
    await b.engine.sync();
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const held = must(
      a.gate.heads.exportHeads().find(({ head }) => head.device === compromised.deviceId)?.head,
    );
    const records = Array.from({ length: MAX_GOSSIP_HISTORY + 1 }, (_, n) => {
      const chain = (seed: number) => {
        const bytes = new Uint8Array(32);
        bytes[0] = seed & 255;
        bytes[1] = seed >> 8;
        return bytes;
      };
      const first = signHead(compromised, vault.ring.vaultId, { ...held, chain: chain(n + 1) });
      const second = signHead(compromised, vault.ring.vaultId, { ...held, chain: chain(n + 1024) });
      return encodeEvidence([first, second]);
    });
    a.state.evidence = [...records];
    a.gate.importEvidence(records);
    expect(a.gate.gossipStatus()).toMatchObject({ overflow: true, authorityUncertain: true });
    expect(a.gate.forks().some((fork) => fork.device === compromised.deviceId)).toBe(true);
    const positions = new Map(a.gate.heads.exportHeads().map(({ head }) => [head.device, head]));
    a.state.value = a.gate.exportState(positions);
    expect(a.state.value).toBeDefined();
    expect(JSON.parse((a.state.value ?? "{}").split("\n")[0] ?? "{}").ledger).toMatchObject({
      overflowDevices: [compromised.deviceId],
    });
    const cut = new Map(a.devices.guard.entries()).get(compromised.deviceId);
    if (!cut) throw new Error("missing synthetic target cut");
    const request = {
      targets: [{ device: compromised.deviceId, applied: cut }],
      revokeEid: newEid(),
      attemptId: newEid(),
      authority: { kind: "recovery" as const },
      selection: { recertify: [] },
    };
    const preview = previewRevocation(a.devices, a.gate, request);
    if (!preview.ok) throw new Error(preview.reason);
    const permit = acknowledgeRevocationPreview(preview.preview, { warning: "acknowledged" });
    if (!permit) throw new Error("missing synthetic permit");
    const prepared = a.devices.prepareRevocation(
      a.gate,
      request,
      permit,
      { revoke: request.revokeEid, rotate: newEid() },
      recovery,
      { recertify: [] },
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    await a.engine.write(prepared.change.events);
    prepared.change.commit();
    expect(a.gate.gossipStatus().authorityUncertain).toBe(false);
    expect(a.gate.forks().some((fork) => fork.device === compromised.deviceId)).toBe(true);
    await a.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "restored" } }]);
    await a.engine.close();
    const cold = await node(
      owner,
      a.devices.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(owner), vault.ring.vaultId),
      remote,
      { local: a.local, sink: a.sink, clock: a.clock, state: a.state },
    );
    await cold.engine.sync();
    expect(cold.gate.gossipStatus().authorityUncertain).toBe(false);
    expect(cold.gate.forks().some((fork) => fork.device === compromised.deviceId)).toBe(true);
    await cold.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "cold-restored" } }]);
    await cold.engine.close();
  });
});
