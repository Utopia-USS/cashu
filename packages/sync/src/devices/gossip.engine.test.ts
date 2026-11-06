import { describe, expect, it } from "vitest";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  encodeHead,
  recoveryIdentity,
  signHead,
} from "../crypto/index.js";
import { MemoryTransport } from "../memory.js";
import { must, node, subjectOf } from "../testing/gossipEngine.js";
import { buildHeadsGossiped } from "./events.js";
import { acknowledgeRevocationPreview, previewRevocation } from "./revocationPolicy.js";
import { newEid, sodium } from "./testkit.js";

describe("real engine gossip emission", () => {
  it("publishes one authenticated local gossip receipt and pushes it in the same sync", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const first = createDeviceIdentity(sodium);
    const second = createDeviceIdentity(sodium);
    const vault = createVaultWithRecovery(sodium, recovery, first);
    const remote = new MemoryTransport();
    const a = await node(
      first,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(first), vault.ring.vaultId),
      remote,
    );
    const b = await node(
      second,
      vault.ring.clone(sodium),
      certifyDevice(sodium, recovery, subjectOf(second), vault.ring.vaultId),
      remote,
    );
    await a.engine.write([a.intro()]);
    await b.engine.write([b.intro()]);
    await a.engine.sync();
    const before =
      (await b.local.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size ?? 0;
    const firstPass = await b.engine.sync();
    expect(firstPass.gossip?.emitted).toBe(true);
    expect(firstPass.gossip?.deliveryPending).toBe(false);
    const after =
      (await b.local.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(
      (await remote.list(vault.ring.vaultId)).find((s) => s.device === second.deviceId)?.size,
    ).toBe(after);
    for (let i = 0; i < 3; i++) {
      expect((await b.engine.sync()).gossip?.emitted).toBe(false);
    }
  });

  it("finds a late lower-position signed fork after compact restart and publishes one proof", async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const ids = [0, 1, 2].map(() => createDeviceIdentity(sodium)) as [
      DeviceIdentity,
      DeviceIdentity,
      DeviceIdentity,
    ];
    const vault = createVaultWithRecovery(sodium, recovery, ids[0]);
    const vaultId = vault.ring.vaultId;
    const remote = new MemoryTransport();
    const certs = ids.map((id) => certifyDevice(sodium, recovery, subjectOf(id), vaultId));
    const a = await node(ids[0], vault.ring.clone(sodium), certs[0] as Uint8Array, remote);
    const b = await node(ids[1], vault.ring.clone(sodium), certs[1] as Uint8Array, remote);
    const c = await node(ids[2], vault.ring.clone(sodium), certs[2] as Uint8Array, remote);
    await a.engine.write([a.intro()]);
    await b.engine.write([b.intro()]);
    await c.engine.write([c.intro()]);
    for (const peer of [a, b, c]) await peer.engine.sync();
    const agreed = must(
      a.gate.heads.exportHeads().find(({ head }) => head.device === a.identity.deviceId)?.head,
    );
    await b.engine.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [agreed])]);
    await b.engine.sync();
    await c.engine.sync();
    const set = () => ({ t: "test.set", v: 1, i: newEid(), d: { value: "synthetic" } });
    await a.engine.write([set()]);
    const a1 = must(
      a.gate.heads.exportHeads().find(({ head }) => head.device === a.identity.deviceId)?.head,
    );
    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();
    await a.engine.write([set()]);
    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();
    const parsed = JSON.parse((c.state.value ?? "{}").split("\n")[0] ?? "{}") as {
      gossip?: unknown[];
    };
    expect(parsed.gossip?.length).toBeLessThanOrEqual(4);
    await c.engine.close();
    const restarted = await node(ids[2], vault.ring.clone(sodium), certs[2] as Uint8Array, remote, {
      local: c.local,
      sink: c.sink,
      clock: c.clock,
      state: c.state,
    });
    const alternate = signHead(ids[0], vaultId, {
      device: ids[0].deviceId,
      stream: 1,
      seg: a1.seg,
      offset: a1.offset,
      chain: new Uint8Array(32).fill(7),
    });
    await b.engine.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [alternate])]);
    await b.engine.sync();
    const historical = restarted.gate.historicalHeadsInFrame.bind(restarted.gate);
    restarted.gate.historicalHeadsInFrame = (frame, events, device, end) =>
      device === ids[0].deviceId ? undefined : historical(frame, events, device, end);
    const unavailable = await restarted.engine.sync();
    for (let round = 0; round < 4; round++) {
      if (restarted.gate.takeHistoricalLookups().every((item) => item.device === ids[0].deviceId))
        break;
      await restarted.engine.sync();
    }
    expect(restarted.gate.takeHistoricalLookups().length).toBeGreaterThan(0);
    expect(
      restarted.gate.takeHistoricalLookups().every((item) => item.device === ids[0].deviceId),
    ).toBe(true);
    expect(unavailable.gossip?.historyPending).toBe(true);
    expect(unavailable.gossip?.deliveryPending).toBe(true);
    expect(unavailable.gossip?.emitted).toBe(false);
    expect(restarted.gate.gossipStatus().authorityUncertain).toBe(true);
    expect(restarted.engine.leaseTransport().kind).toBe("eventual");
    await expect(
      restarted.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "blocked" } }]),
    ).rejects.toMatchObject({ code: "authority-unresolved" });
    await expect(
      restarted.engine.write([{ t: "device.revoked", v: 1, i: newEid(), d: {} }]),
    ).rejects.toMatchObject({ code: "authority-unresolved" });
    const cut = new Map(restarted.devices.guard.entries()).get(ids[0].deviceId);
    if (!cut) throw new Error("missing synthetic target cut");
    const request = {
      targets: [{ device: ids[0].deviceId, applied: cut }],
      revokeEid: newEid(),
      attemptId: newEid(),
      authority: { kind: "recovery" as const },
      selection: { recertify: [] },
    };
    const preview = previewRevocation(restarted.devices, restarted.gate, request);
    if (!preview.ok) throw new Error(preview.reason);
    const permit = acknowledgeRevocationPreview(preview.preview, { warning: "acknowledged" });
    if (!permit) throw new Error("missing synthetic permit");
    const prepared = restarted.devices.prepareRevocation(
      restarted.gate,
      request,
      permit,
      { revoke: request.revokeEid, rotate: newEid() },
      recovery,
      { recertify: [] },
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const oldRevoke = prepared.change.events[0];
    expect(oldRevoke?.t).toBe("device.revoked");
    if (!oldRevoke) throw new Error("missing prepared revoke");
    const wrongSignature = {
      ...oldRevoke,
      d: { ...oldRevoke.d, sig: "00".repeat(64) },
    };
    expect(() => restarted.gate.stageRecoveryRevocationBatch([wrongSignature], recovery)).toThrow(
      "invalid prepared recovery revocation batch",
    );
    await expect(
      restarted.engine.write([
        oldRevoke,
        { t: "test.set", v: 1, i: newEid(), d: { value: "smuggled" } },
      ]),
    ).rejects.toMatchObject({ code: "authority-unresolved" });
    const mutable = prepared.change.events as unknown as { d: Record<string, unknown> }[];
    (mutable[0] as { d: Record<string, unknown> }).d = wrongSignature.d;
    await expect(restarted.engine.write(prepared.change.events)).rejects.toMatchObject({
      code: "authority-unresolved",
    });
    prepared.change.discard();
    const retryRequest = { ...request, revokeEid: newEid(), attemptId: newEid() };
    const retryPreview = previewRevocation(restarted.devices, restarted.gate, retryRequest);
    if (!retryPreview.ok) throw new Error(retryPreview.reason);
    const retryPermit = acknowledgeRevocationPreview(retryPreview.preview, {
      warning: "acknowledged",
    });
    if (!retryPermit) throw new Error("missing retry permit");
    const retry = restarted.devices.prepareRevocation(
      restarted.gate,
      retryRequest,
      retryPermit,
      { revoke: retryRequest.revokeEid, rotate: newEid() },
      recovery,
      { recertify: [] },
    );
    if (!retry.ok) throw new Error(retry.reason);
    await restarted.engine.write(retry.change.events);
    retry.change.commit();
    expect(restarted.devices.registry.revoked.has(ids[0].deviceId)).toBe(true);
    expect(restarted.gate.gossipStatus().historyPending).toBe(false);
    expect(restarted.gate.takeHistoricalLookups()).toHaveLength(0);
    const ineffective = retry.change.events[0];
    if (!ineffective) throw new Error("missing committed revoke");
    expect(() => restarted.gate.stageRecoveryRevocationBatch([ineffective], recovery)).toThrow(
      "invalid prepared recovery revocation batch",
    );
    expect(
      restarted.gate.exportState(
        new Map(restarted.gate.heads.exportHeads().map(({ head }) => [head.device, head])),
      ),
    ).toBeDefined();
    let outcome = await restarted.engine.sync();
    for (let round = 0; round < 3 && outcome.gossip?.historyPending; round++) {
      expect(outcome.gossip?.emitted).toBe(false);
      outcome = await restarted.engine.sync();
    }
    expect(restarted.gate.takeHistoricalLookups()).toHaveLength(0);
    expect(outcome.gossip?.historyPending).toBe(false);
    expect(outcome.gossip?.deliveryPending).toBe(false);
    expect(restarted.gate.gossipStatus().authorityUncertain).toBe(false);
    await restarted.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "restored" } }]);
    expect(restarted.gate.forks()).toContainEqual({
      device: ids[0].deviceId,
      agreed: { seg: agreed.seg, offset: agreed.offset },
    });
    expect(c.state.evidence).toHaveLength(1);
    expect(outcome.gossip?.emitted).toBe(true);
    expect((await restarted.engine.sync()).gossip?.emitted).toBe(false);
    expect(
      restarted.gate.gossipCandidates().some((head) => encodeHead(head) === encodeHead(alternate)),
    ).toBe(false);
    await restarted.engine.close();
    const cold = await node(
      ids[2],
      restarted.devices.ring.clone(sodium),
      certs[2] as Uint8Array,
      remote,
      { local: c.local, sink: c.sink, clock: c.clock, state: c.state },
    );
    await cold.engine.sync();
    expect(cold.engine.writeAdmission()).toBe("ready");
    await cold.engine.write([{ t: "test.set", v: 1, i: newEid(), d: { value: "after-restart" } }]);
    await cold.engine.close();
  });
});
