// Opt-in measurement of the phone's open cost (B2): a local log of N one-event frames (default 20,000),
// opened by `recoverLocal` without a checkpoint (the hosts' behaviour, and the phone before B2), with a
// checkpoint and no tail, with a checkpoint and a 100-frame tail, and the full replay with the native
// Ed25519 verifier bound (libsodium-wrappers, the stand-in for react-native-libsodium). Prints wall
// time and the number of signature verifies per open. Skipped unless CASHU_OPEN_BENCH=1, so the default
// tier never builds the log:
//   CASHU_OPEN_BENCH=1 [CASHU_OPEN_BENCH_FRAMES=20000] pnpm --filter @cashu/sync exec vitest run src/devices/openCost.measure.test.ts
// Synthetic data only.
import { describe, expect, it } from "vitest";
import type { EventSink, InboundBatch, RecoveryCheckpointStore } from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import {
  bindEd25519Verifier,
  type Ed25519Verifier,
  type LibsodiumSignLike,
  libsodiumEd25519Verifier,
  nobleEd25519Verifier,
} from "../crypto/ed25519.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  recoveryIdentity,
  verifyContextSignature,
} from "../crypto/index.js";
import { createSyncEngine } from "../engine.js";
import { newEid, sodium } from "../testing/devices/testkit.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { MemoryClockStore, MemoryTransport } from "../testing/memory.js";
import { buildDeviceAdded } from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { VaultDevices } from "./vaultDevices.js";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const ENABLED = env?.CASHU_OPEN_BENCH === "1";
const FRAMES = Number(env?.CASHU_OPEN_BENCH_FRAMES ?? 20_000);
const T0 = Date.UTC(2026, 10, 1, 12);
const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

class ViewSink extends MemorySink {
  override applyBatches(batches: readonly InboundBatch[]) {
    return super.applyBatches(
      batches.map((b) => ({ ...b, events: b.events.filter((e) => e.t === "test.set") })),
    );
  }
}

describe.skipIf(!ENABLED)("open cost (opt-in measurement)", () => {
  it(`opens a ${FRAMES}-frame log with and without the checkpoint`, async () => {
    const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const identity = createDeviceIdentity(sodium);
    const vault = createVaultWithRecovery(sodium, recovery, identity);
    const vaultId = vault.ring.vaultId;
    const subject = {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    };
    const certificate = certifyDevice(sodium, recovery, subject, vaultId);
    const local = new MemoryTransport();
    const clockStore = new MemoryClockStore();
    let text: string | undefined;
    const store: RecoveryCheckpointStore = {
      load: () => text,
      save: (t) => {
        text = t;
      },
      clear: () => {
        text = undefined;
      },
    };
    let snapshot: string | undefined;
    const open = (checkpoint: boolean, sink: EventSink) => {
      const ring = vault.ring.clone(sodium);
      return createSyncEngine({
        vault: vaultId,
        device: identity.deviceId,
        local,
        codec: createOwnLogCodec({ sodium, ring, signer: identity }),
        gate: new DeviceFrameGate(
          new VaultDevices({
            sodium,
            identity,
            ring,
            provenance: new MemoryProvenanceStore(),
            clock: () => T0,
            bootstrapCertificates: [certificate],
          }),
          { sodium },
        ),
        sink,
        clockStore,
        gateState: {
          load: () => snapshot,
          save: (s) => {
            snapshot = s;
          },
        },
        physicalClock: new ManualClock(T0),
        ...(checkpoint
          ? {
              recoveryCheckpoint: {
                store,
                binding: () => "ring",
                sign: (body: Uint8Array) => identity.sign("cashu/checkpoint/v1", body),
                verify: (body: Uint8Array, sig: Uint8Array) =>
                  verifyContextSignature("cashu/checkpoint/v1", body, sig, identity.signPublicKey),
              },
            }
          : {}),
      });
    };
    const write = async (n: number, prefix: string) => {
      const engine = await open(false, new ViewSink());
      for (let i = 0; i < n; i++) {
        await engine.write([{ t: "test.set", v: 1, i: newEid(), g: `${prefix}${i}`, d: { v: i } }]);
      }
      await engine.close();
    };
    const seed = await open(false, new ViewSink());
    await seed.write([buildDeviceAdded(identity, vaultId, newEid(), subject, "d", certificate)]);
    await seed.close();
    const built = now();
    await write(FRAMES - 1, "g");
    const buildMs = now() - built;

    const measure = async (label: string, checkpoint: boolean, verifier: Ed25519Verifier) => {
      let verifies = 0;
      const previous = bindEd25519Verifier({
        kind: verifier.kind,
        verify: (s, m, p) => {
          verifies += 1;
          return verifier.verify(s, m, p);
        },
      });
      try {
        const start = now();
        const engine = await open(checkpoint, view);
        const result = await engine.recoverLocal();
        const ms = now() - start;
        await engine.close();
        expect(result.complete).toBe(true);
        return { label, ms: Math.round(ms), verifies };
      } finally {
        bindEd25519Verifier(previous);
      }
    };
    const { default: wrappers } = (await import("libsodium-wrappers")) as unknown as {
      default: LibsodiumSignLike & { ready: Promise<void> };
    };
    await wrappers.ready;
    const native = libsodiumEd25519Verifier(wrappers);
    // One view across the opens, as on the phone: a warm-up replay applies the log once.
    const view = new ViewSink();
    const warm = await open(false, view);
    expect((await warm.recoverLocal()).complete).toBe(true);
    await warm.close();
    const rows = [
      await measure("full replay, @noble (before B2)", false, nobleEd25519Verifier),
      await measure("full replay, native verify", false, native),
      await measure("full replay that writes the checkpoint", true, nobleEd25519Verifier),
      await measure("checkpoint, no tail, @noble", true, nobleEd25519Verifier),
    ];
    await write(100, "t");
    rows.push(await measure("checkpoint, 100-frame tail, @noble", true, nobleEd25519Verifier));
    rows.push(await measure("checkpoint, no tail, native", true, native));
    console.log(JSON.stringify({ frames: FRAMES, buildMs: Math.round(buildMs), rows }, null, 2));
  }, 3_600_000);
});
