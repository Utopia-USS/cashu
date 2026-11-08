import { describe, expect, it } from "vitest";
import type { EventSink, FrameGate, GateStateStore, SegmentCursor, Transport } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  recoveryIdentity,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { formatHlc } from "../hlc.js";
import { encodePayload, frameBytes, scanFrames } from "../segment.js";
import { newEid, sodium } from "../testing/devices/testkit.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { MemoryClockStore, MemoryTransport } from "../testing/memory.js";
import { buildDeviceAdded, buildDeviceRevoked } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);

function unavailableRemote(): Transport {
  const fail = (): never => {
    throw new Error("recovery touched remote");
  };
  return {
    consistency: { kind: "linearizable" },
    list: fail,
    read: fail,
    append: fail,
  };
}

async function appendPayload(
  f: ReturnType<typeof fixture>,
  plain: Uint8Array,
  signer: DeviceIdentity = f.identity,
): Promise<void> {
  const vaultId = f.vault.ring.vaultId;
  const device = f.identity.deviceId;
  const codec = createOwnLogCodec({ sodium, ring: f.vault.ring.clone(sodium), signer });
  const bytes = await f.local.read(vaultId, device, 1, 0);
  let prev = codec.genesis(vaultId, device, 1);
  for (const frame of scanFrames(bytes, 0).frames) {
    prev = codec.link(frame.sealed, { vault: vaultId, device, seg: 1, offset: frame.offset }, prev);
  }
  const at = { vault: vaultId, device, seg: 1, offset: bytes.length };
  const sealed = await codec.seal(plain, at, prev);
  await f.local.append(vaultId, device, 1, bytes.length, frameBytes(sealed.sealed));
}

function fixture() {
  const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
  const identity = createDeviceIdentity(sodium);
  const vault = createVaultWithRecovery(sodium, recovery, identity);
  const certificate = certifyDevice(
    sodium,
    recovery,
    {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    },
    vault.ring.vaultId,
  );
  const local = new MemoryTransport();
  const sink = new MemorySink();
  const clockStore = new MemoryClockStore();
  let snapshot: string | undefined;
  const gateState: GateStateStore = {
    load: () => snapshot,
    save: (state) => {
      snapshot = state;
    },
  };
  const open = (
    options: {
      local?: Transport;
      sink?: EventSink;
      bootstrap?: boolean;
      maxFrameEvents?: number;
      gate?: (real: DeviceFrameGate) => FrameGate;
      gateState?: boolean;
    } = {},
  ) => {
    const ring = vault.ring.clone(sodium);
    const devices = new VaultDevices({
      sodium,
      identity,
      ring,
      provenance: new MemoryProvenanceStore(),
      clock: () => T0,
      bootstrapCertificates: options.bootstrap === false ? [] : [certificate],
    });
    const realGate = new DeviceFrameGate(devices, { sodium });
    return createSyncEngine({
      vault: ring.vaultId,
      device: identity.deviceId,
      local: options.local ?? local,
      remotes: [unavailableRemote()],
      codec: createOwnLogCodec({ sodium, ring, signer: identity }),
      gate: options.gate?.(realGate) ?? realGate,
      sink: options.sink ?? sink,
      clockStore,
      ...(options.gateState ? { gateState } : {}),
      physicalClock: new ManualClock(T0),
      ...(options.maxFrameEvents === undefined ? {} : { maxFrameEvents: options.maxFrameEvents }),
    });
  };
  const intro = () =>
    buildDeviceAdded(
      identity,
      vault.ring.vaultId,
      newEid(),
      {
        deviceId: identity.deviceId,
        signPublicKey: identity.signPublicKey,
        boxPublicKey: identity.box.publicKey,
      },
      "device",
      certificate,
    );
  return { identity, recovery, vault, local, sink, clockStore, gateState, open, intro };
}

async function secondWriter(f: ReturnType<typeof fixture>) {
  const identity = createDeviceIdentity(sodium);
  const vaultId = f.vault.ring.vaultId;
  const subject = {
    deviceId: identity.deviceId,
    signPublicKey: identity.signPublicKey,
    boxPublicKey: identity.box.publicKey,
  };
  const certificate = certifyDevice(sodium, f.recovery, subject, vaultId);
  const ring = f.vault.ring.clone(sodium);
  const devices = new VaultDevices({
    sodium,
    identity,
    ring,
    provenance: new MemoryProvenanceStore(),
    clock: () => T0,
    bootstrapCertificates: [certificate],
  });
  const engine = await createSyncEngine({
    vault: vaultId,
    device: identity.deviceId,
    local: f.local,
    codec: createOwnLogCodec({ sodium, ring, signer: identity }),
    gate: new DeviceFrameGate(devices, { sodium }),
    sink: new MemorySink(),
    clockStore: new MemoryClockStore(),
    physicalClock: new ManualClock(T0),
  });
  const admission = buildDeviceAdded(f.recovery, vaultId, newEid(), subject, "second", certificate);
  const event = (gid: string) => ({ t: "test.set", v: 1, i: newEid(), g: gid, d: { value: gid } });
  return { identity, engine, admission, event };
}

describe("local-only recovery", () => {
  it("authenticates a held encrypted genesis without touching a remote or appending", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    const before = await f.local.read(f.vault.ring.vaultId, f.identity.deviceId, 1, 0);
    const reopened = await f.open();
    const result = await reopened.recoverLocal();
    const after = await f.local.read(f.vault.ring.vaultId, f.identity.deviceId, 1, 0);
    expect(result.complete).toBe(true);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.inspectedThrough).toEqual(result.streams[0]?.heldEnd);
    expect(after).toEqual(before);
  });

  it("refuses a partial held tail", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    const listed = await f.local.list(f.vault.ring.vaultId);
    const size = listed[0]?.size ?? 0;
    await f.local.append(
      f.vault.ring.vaultId,
      f.identity.deviceId,
      1,
      size,
      new Uint8Array([0, 0]),
    );
    const reopened = await f.open();
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.streams[0]?.reason).toBe("partial");
  });

  it.each(["bad-signature", "bad-aead", "malformed-payload"] as const)(
    "refuses a held %s frame",
    async (fault) => {
      const f = fixture();
      const first = await f.open();
      await first.write([f.intro()]);
      await first.close();
      const vaultId = f.vault.ring.vaultId;
      const device = f.identity.deviceId;
      const bytes = await f.local.read(vaultId, device, 1, 0);
      if (fault === "bad-aead") {
        await f.local.append(vaultId, device, 1, bytes.length, frameBytes(new Uint8Array(80)));
      } else {
        const plain =
          fault === "malformed-payload"
            ? new TextEncoder().encode("not json")
            : new TextEncoder().encode(
                JSON.stringify({
                  f: 1,
                  e: [
                    {
                      t: "test.set",
                      v: 1,
                      i: newEid(),
                      g: "g1",
                      d: { value: "x" },
                      h: formatHlc({ wall: T0, counter: 2, device }),
                    },
                  ],
                }),
              );
        await appendPayload(
          f,
          plain,
          fault === "bad-signature" ? createDeviceIdentity(sodium, device) : f.identity,
        );
      }
      const reopened = await f.open();
      const result = await reopened.recoverLocal();
      expect(result.complete).toBe(false);
      expect(result.streams[0]?.disposition).toBe("unresolved_tail");
      expect(result.streams[0]?.inspectedThrough.offset).toBe(bytes.length);
    },
  );

  it("treats a signed held snapshot as a local durability anchor", async () => {
    const f = fixture();
    const first = await f.open({ gateState: true });
    await first.write([f.intro()]);
    expect((await first.recoverLocal()).complete).toBe(true);
    await first.close();
    const missing: Transport = {
      consistency: f.local.consistency,
      list: async () => [],
      read: async () => new Uint8Array(0),
      append: () => {
        throw new Error("recovery appended");
      },
    };
    const reopened = await f.open({ gateState: true, local: missing });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.streams[0]?.reason).toBe("local-anchor-missing");
  });

  it("rejects a far-future HWM before clock save or local append", async () => {
    const f = fixture();
    const engine = await f.open();
    const beforeClock = await f.clockStore.load();
    const afterHlc = formatHlc({ wall: T0 + 600_000, counter: 0, device: f.identity.deviceId });
    await expect(engine.write([f.intro()], { afterHlc })).rejects.toMatchObject({
      code: "remote-far-future",
    });
    expect(await f.clockStore.load()).toEqual(beforeClock);
    expect(await f.local.list(f.vault.ring.vaultId)).toEqual([]);
  });

  it("reports a previously parked domain event behind the existing cursor", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([
      f.intro(),
      { t: "future.kind", v: 2, i: newEid(), g: "g1", d: { value: "synthetic" } },
    ]);
    await first.close();
    expect(f.sink.needsUpgrade()).toBe(true);
    const reopened = await f.open();
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(true);
    expect(result.needsUpgrade).toBe(true);
    expect(result.streams[0]?.disposition).toBe("authenticated_accepted");
  });

  it("refuses a cursor inside an authenticated frame group", async () => {
    const f = fixture();
    const first = await f.open({ maxFrameEvents: 1 });
    await first.write([
      f.intro(),
      { t: "test.set", v: 1, i: newEid(), g: "g1", d: { value: "x" } },
    ]);
    await first.close();
    const bytes = await f.local.read(f.vault.ring.vaultId, f.identity.deviceId, 1, 0);
    const inside: SegmentCursor = { seg: 1, offset: scanFrames(bytes, 0).frames[0]?.end ?? 0 };
    let resetCalled = false;
    const sink: EventSink = {
      cursors: () => new Map([[f.identity.deviceId, inside]]),
      applyBatches: (batches) => f.sink.applyBatches(batches),
      reset: () => {
        resetCalled = true;
      },
      needsUpgrade: () => f.sink.needsUpgrade(),
    };
    const reopened = await f.open({ sink });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.requiresViewRebuild).toBe(true);
    expect(result.streams[0]?.reason).toBe("cursor-not-accepted");
    expect(resetCalled).toBe(false);
  });

  it("refuses an incomplete authenticated frame group", async () => {
    const f = fixture();
    const first = await f.open({ maxFrameEvents: 1 });
    await first.write([
      f.intro(),
      { t: "test.set", v: 1, i: newEid(), g: "g1", d: { value: "x" } },
    ]);
    await first.close();
    const vaultId = f.vault.ring.vaultId;
    const full = await f.local.read(vaultId, f.identity.deviceId, 1, 0);
    const firstEnd = scanFrames(full, 0).frames[0]?.end ?? 0;
    const cut: Transport = {
      consistency: f.local.consistency,
      list: async () => [{ device: f.identity.deviceId, seg: 1, size: firstEnd }],
      read: async () => full.subarray(0, firstEnd),
      append: () => {
        throw new Error("recovery appended");
      },
    };
    const reopened = await f.open({ local: cut });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.streams[0]?.reason).toBe("incomplete-group");
  });

  it("refuses a sink cursor ahead of its held encrypted log", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    const sink: EventSink = {
      cursors: () => new Map([[f.identity.deviceId, { seg: 9, offset: 1 }]]),
      applyBatches: (batches) => f.sink.applyBatches(batches),
      reset: () => {
        throw new Error("recovery reset active view");
      },
    };
    const reopened = await f.open({ sink });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.requiresViewRebuild).toBe(true);
    expect(result.streams[0]?.reason).toBe("cursor-not-accepted");
  });

  it("refuses an unknown writer whose certificate is absent", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([{ t: "test.set", v: 1, i: newEid(), g: "g1", d: { value: "x" } }]);
    await first.close();
    const reopened = await f.open({ bootstrap: false });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.streams[0]?.reason).toBe("writer-unknown");
  });

  it("resolves an initial unknown writer from a later held stream", async () => {
    const f = fixture();
    const b = await secondWriter(f);
    await b.engine.write([b.event("g1")]);
    await b.engine.close();
    const a = await f.open();
    await a.write([f.intro(), b.admission]);
    await a.close();
    const reopened = await f.open();
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(true);
    expect(result.streams).toHaveLength(2);
    expect(
      result.streams.every((stream) => stream.inspectedThrough.offset === stream.heldEnd.offset),
    ).toBe(true);
  });

  it("inspects a signed revoked tail, suppresses it, and marks a stale prior cursor", async () => {
    const f = fixture();
    const a = await f.open();
    const b = await secondWriter(f);
    await a.write([f.intro(), b.admission]);
    await b.engine.write([b.event("before")]);
    const firstEnd =
      (await f.local.list(f.vault.ring.vaultId)).find(
        (segment) => segment.device === b.identity.deviceId,
      )?.size ?? 0;
    await b.engine.write([b.event("after")]);
    await b.engine.close();
    expect((await a.recoverLocal()).complete).toBe(true);
    expect(f.sink.value("after")).toBe("after");
    await a.close();

    const revocation = buildDeviceRevoked(f.recovery, f.vault.ring.vaultId, newEid(), [
      { device: b.identity.deviceId, cut: { seg: 1, offset: firstEnd } },
    ]);
    await appendPayload(
      f,
      encodePayload({
        events: [
          { ...revocation, h: formatHlc({ wall: T0, counter: 9, device: f.identity.deviceId }) },
        ],
      }),
    );
    f.clockStore.save({ wall: T0, counter: 9 });

    const freshSink = new MemorySink();
    const clean = await f.open({ sink: freshSink });
    const cleanResult = await clean.recoverLocal();
    expect(cleanResult.complete).toBe(true);
    expect(cleanResult.streams.find((s) => s.device === b.identity.deviceId)?.disposition).toBe(
      "authenticated_suppressed",
    );
    expect(freshSink.value("before")).toBe("before");
    expect(freshSink.value("after")).toBeUndefined();
    await clean.close();

    const stale = await f.open();
    const staleResult = await stale.recoverLocal();
    expect(staleResult.complete).toBe(false);
    expect(staleResult.requiresViewRebuild).toBe(true);
    expect(staleResult.streams.find((s) => s.device === b.identity.deviceId)?.reason).toBe(
      "cursor-not-accepted",
    );
    expect((await stale.recoverLocal()).complete).toBe(false);
  });

  it("refuses a short local read even when the listed size is complete", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    const short: Transport = {
      consistency: f.local.consistency,
      list: (vault) => f.local.list(vault),
      read: async (vault, device, seg, offset) =>
        (await f.local.read(vault, device, seg, offset)).subarray(0, -1),
      append: () => {
        throw new Error("recovery appended");
      },
    };
    const reopened = await f.open({ local: short });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.streams[0]?.reason).toBe("short-read");
  });

  it("retries an incomplete local audit after the held read is repaired", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    let short = false;
    const local: Transport = {
      consistency: f.local.consistency,
      list: (vault) => f.local.list(vault),
      read: async (vault, device, seg, offset) => {
        const bytes = await f.local.read(vault, device, seg, offset);
        return short ? bytes.subarray(0, -1) : bytes;
      },
      append: () => {
        throw new Error("recovery appended");
      },
    };
    const reopened = await f.open({ local });
    short = true;
    expect((await reopened.recoverLocal()).complete).toBe(false);
    short = false;
    const repaired = await reopened.recoverLocal();
    expect(repaired.complete).toBe(true);
    expect(repaired.streams[0]?.inspectedThrough).toEqual(repaired.streams[0]?.heldEnd);
  });

  it("refuses a missing first segment", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    const gap: Transport = {
      consistency: f.local.consistency,
      list: async (vault) => (await f.local.list(vault)).map((segment) => ({ ...segment, seg: 2 })),
      read: () => {
        throw new Error("recovery read past gap");
      },
      append: () => {
        throw new Error("recovery appended");
      },
    };
    const reopened = await f.open({ local: gap });
    const result = await reopened.recoverLocal();
    expect(result.complete).toBe(false);
    expect(result.streams[0]?.reason).toBe("segment-gap");
  });

  it("retains a consumed rebuild requirement across recovery calls on the same sink", async () => {
    const f = fixture();
    const first = await f.open();
    await first.write([f.intro()]);
    await first.close();
    let pending = true;
    const reopened = await f.open({
      gate: (real) =>
        new Proxy(real, {
          get(target, property) {
            if (property === "takeRebuild")
              return () => {
                const result = pending;
                pending = false;
                return result;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const firstReport = await reopened.recoverLocal();
    const secondReport = await reopened.recoverLocal();
    expect(firstReport.requiresViewRebuild).toBe(true);
    expect(secondReport.requiresViewRebuild).toBe(true);
    expect(secondReport.complete).toBe(false);
  });
});
