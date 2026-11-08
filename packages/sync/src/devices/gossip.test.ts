import { describe, expect, it } from "vitest";
import { createDeviceIdentity, decodeHead, encodeHead, signHead } from "../crypto/index.js";
import { note, syncAll } from "../testing/devices/orderSim.js";
import {
  createSimVault,
  newEid,
  pairDevice,
  revokeWithConsent,
  sodium,
} from "../testing/devices/testkit.js";
import { fromHex } from "./bytes.js";
import {
  buildHeadsGossiped,
  decodeDeviceAdded,
  decodeHeadsGossiped,
  HEADS_GOSSIPED,
} from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MAX_GOSSIP_HISTORY } from "./gossip.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { VaultDevices } from "./vaultDevices.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture");
  return value;
}

describe("authenticated head gossip", () => {
  it("strictly encodes a bounded, sorted, unique signed-head event", async () => {
    const { creator: a, vaultId } = createSimVault();
    const head = must(a.stream.at(-1)?.head);
    const event = buildHeadsGossiped(a.identity, vaultId, newEid(), [head]);
    expect(event.t).toBe(HEADS_GOSSIPED);
    expect(decodeHeadsGossiped(event.d)?.heads).toEqual([encodeHead(head)]);
    expect(() => buildHeadsGossiped(a.identity, vaultId, newEid(), [head, head])).toThrow();
    expect(
      decodeHeadsGossiped({ ...event.d, heads: [encodeHead(head).toUpperCase()] }),
    ).toBeUndefined();
    expect(decodeHeadsGossiped({ ...event.d, extra: true })).toBeUndefined();
    expect(decodeHead(encodeHead(head))?.device).toBe(a.id);
  });

  it("deduplicates repeated frontiers and drops unknown-device hints without blocking authority", () => {
    const { creator: a, vaultId } = createSimVault();
    const head = must(a.stream.at(-1)).head;
    const offer = (item: typeof head, n: number) => {
      const event = buildHeadsGossiped(a.identity, vaultId, newEid(), [item]);
      a.gate.ingest([
        {
          eid: event.i,
          hlc: "0mvwcmtc0-0000-daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          writer: a.id,
          position: { seg: 1, offset: 1000 + n },
          type: event.t,
          v: event.v,
          data: event.d,
        },
      ]);
    };
    for (let n = 0; n < MAX_GOSSIP_HISTORY + 1; n++) offer(head, n);
    const compact = must(a.gate.exportState(new Map())).split("\n")[0];
    expect(JSON.parse(compact ?? "{}").gossip).toHaveLength(1);
    expect(a.gate.gossipStatus().overflow).toBe(false);
    const stranger = createDeviceIdentity(sodium);
    for (let n = 0; n < MAX_GOSSIP_HISTORY + 1; n++) {
      offer(
        signHead(stranger, vaultId, {
          device: stranger.deviceId,
          stream: 1,
          seg: 1,
          offset: 100,
          chain: new Uint8Array(32).fill(n % 256),
        }),
        n + MAX_GOSSIP_HISTORY + 1,
      );
    }
    expect(a.gate.gossipStatus().overflow).toBe(false);
    expect(a.gate.gossipStatus().retained).toBe(1);
    expect(a.gate.gossipStatus().historyPending).toBe(false);
    expect(a.gate.gossipStatus().authorityUncertain).toBe(false);
  });

  it("relays an unchanged A head through B and C while A is withheld, without echoing envelopes", async () => {
    const { creator: a } = createSimVault();
    const b = await pairDevice(a, "b");
    const c = await pairDevice(a, "c");
    const d = await pairDevice(a, "d");
    syncAll([a, b, c, d]);
    const knownA = must(a.stream.at(-1)).cursor.offset;
    a.write([note()]);
    const a1 = encodeHead(must(a.stream.at(-1)).head);
    a.push();
    b.pull();
    const aBatch = must(a.stream.at(-1));
    b.gate.accept(
      aBatch.head,
      aBatch.events.map((e) => ({ t: e.type, v: e.v, h: e.hlc, i: e.eid, d: e.data })),
    );
    const bEvent = b.gate.prepareGossip(newEid());
    expect(decodeHeadsGossiped(bEvent?.d ?? {})?.heads).toContain(a1);
    b.write([must(bEvent)]);
    b.push();
    c.pull((batch) => batch.device !== a.id || batch.cursor.offset <= knownA);
    expect(c.gate.behind().some((r) => r.device === a.id)).toBe(true);
    const cEvent = c.gate.prepareGossip(newEid());
    expect(decodeHeadsGossiped(cEvent?.d ?? {})?.heads).toContain(a1);
    c.write([must(cEvent)]);
    c.push();
    d.pull((batch) => batch.device !== a.id || batch.cursor.offset <= knownA);
    const dEvent = d.gate.prepareGossip(newEid());
    expect(decodeHeadsGossiped(dEvent?.d ?? {})?.heads).toContain(a1);
    d.write([must(dEvent)]);
    d.push();
    a.pull();
    expect(a.gate.gossipCandidates().some((h) => encodeHead(h) === a1)).toBe(false);
    for (const device of [b, c, d]) {
      expect(device.gate.gossipCandidates().some((h) => encodeHead(h) === a1)).toBe(false);
    }
    expect(
      b.gate
        .gossipCandidates()
        .some((h) => h.device === c.id && h.offset === must(c.stream.at(-1)).cursor.offset),
    ).toBe(false);
  });

  it("a revoked writer's post-cut gossip cannot create a behind report or a candidate", async () => {
    const { creator: a, vaultId } = createSimVault();
    const b = await pairDevice(a, "b");
    const c = await pairDevice(a, "c");
    syncAll([a, b, c]);
    c.write([note()]);
    syncAll([a, b, c]);
    revokeWithConsent(a, [b]);
    syncAll([a, b, c]);
    const heldC = must(c.stream.at(-1)).cursor.offset;
    c.write([note()]);
    const laterC = must(c.stream.at(-1)).head;
    c.push();
    const event = buildHeadsGossiped(b.identity, vaultId, newEid(), [laterC]);
    b.write([event]);
    b.push();
    a.pull((batch) => batch.device !== c.id || batch.cursor.offset <= heldC);
    expect(a.gate.behind().some((r) => r.device === c.id)).toBe(false);
    expect(a.gate.gossipCandidates().some((h) => encodeHead(h) === encodeHead(laterC))).toBe(false);
  });

  it("recovers a late lower-position fork from exact older history after compact snapshot restore", async () => {
    const { creator: a, vaultId } = createSimVault();
    const b = await pairDevice(a, "b");
    const c = await pairDevice(a, "c");
    syncAll([a, b, c]);
    const agreed = must(a.stream.at(-1)).head;
    b.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [agreed])]);
    b.push();
    c.pull();
    a.write([note()]);
    a.push();
    b.pull();
    const a1 = must(a.stream.at(-1)).head;
    b.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [a1])]);
    b.push();
    c.pull();
    a.write([note()]);
    a.push();
    const a2 = must(a.stream.at(-1)).head;
    b.pull();
    b.write([buildHeadsGossiped(b.identity, vaultId, newEid(), [a2])]);
    b.push();
    c.pull();
    const positions = new Map(c.gate.heads.exportHeads().map(({ head }) => [head.device, head]));
    const snapshot = must(c.gate.exportState(positions));
    const certificate = must(
      c.devices.registry.events
        .map((event) => decodeDeviceAdded(event.data))
        .find((data) => data?.device === c.id)?.certificate,
    );
    const restoredDevices = new VaultDevices({
      sodium,
      identity: c.identity,
      ring: c.ring.clone(sodium),
      provenance: new MemoryProvenanceStore(),
      clock: () => c.now(),
      bootstrapCertificates: [fromHex(certificate)],
    });
    const gate = new DeviceFrameGate(restoredDevices, { sodium });
    const imported = must(gate.importState(snapshot));
    imported.restore();
    expect(restoredDevices.registry.isTrusted(c.id)).toBe(true);
    expect(gate.heads.headAt(a.id, { seg: a1.seg, offset: a1.offset })).toBeUndefined();
    expect(gate.heads.held(a.id)).toEqual({ seg: a2.seg, offset: a2.offset });
    const alternate = signHead(a.identity, vaultId, {
      device: a.id,
      stream: 1,
      seg: a1.seg,
      offset: a1.offset,
      chain: new Uint8Array(32).fill(7),
    });
    const late = buildHeadsGossiped(b.identity, vaultId, newEid(), [alternate]);
    gate.ingest([
      {
        eid: late.i,
        hlc: must(must(b.stream.at(-1)).events.at(-1)).hlc,
        writer: b.id,
        position: { seg: 1, offset: must(b.stream.at(-1)).cursor.offset + 100 },
        type: late.t,
        v: late.v,
        data: late.d,
      },
    ]);
    const lookup = gate.takeHistoricalLookups();
    expect(lookup).toHaveLength(1);
    expect(gate.gossipStatus().historyPending).toBe(true);
    expect(gate.prepareGossip(newEid())).toBeUndefined();
    expect(gate.exportState(positions)).toBeUndefined();
    gate.resolveHistoricalLookup(must(lookup[0]).candidate, [encodeHead(a1), encodeHead(agreed)]);
    expect(gate.forks()).toContainEqual({
      device: a.id,
      agreed: { seg: agreed.seg, offset: agreed.offset },
    });
    expect(gate.takeEvidence()).toHaveLength(1);
    expect(gate.gossipStatus()).toMatchObject({ historyPending: false, overflow: false });
    expect(gate.gossipCandidates().length).toBeGreaterThan(0);
    expect(decodeHeadsGossiped(gate.prepareGossip(newEid())?.d ?? {})?.heads).toEqual(
      expect.arrayContaining([encodeHead(a1), encodeHead(alternate)]),
    );
  });
});
