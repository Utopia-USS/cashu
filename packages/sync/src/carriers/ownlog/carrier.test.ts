import { describe, expect, it } from "vitest";
import {
  createDeviceIdentity,
  createKeyring,
  createRecoveryKey,
  loadNodeSodium,
} from "../../crypto/index.js";
import { TransportError } from "../../errors.js";
import { MemoryTransport } from "../../memory.js";
import { frameBytes, scanFrames } from "../../segment.js";
import { testSigners } from "../../testing/signers.js";
import { createOwnLogCarrier } from "./carrier.js";
import { createOwnLogCodec } from "./codec.js";
import { encodeRecord, MANIFEST_SEG } from "./manifest.js";

const sodium = await loadNodeSodium();
const VAULT = "ca77ca77ca77ca77ca77ca77ca77ca77";
const A = "a1".repeat(16);
const B = "b2".repeat(16);
const ring = createKeyring(sodium, createRecoveryKey(sodium).publicKeys, VAULT);
const signers = testSigners(sodium, ring);
const codec = signers.codecFor(A);
const gate = signers.gateFor(A);
signers.identityOf(B);

/** The chain after the manifest records of A that `raw` holds (what the next record links to). */
async function manifestChain(raw: MemoryTransport): Promise<Uint8Array> {
  let prev = codec.genesis(VAULT, A, 0);
  const bytesOf = await raw.read(VAULT, A, MANIFEST_SEG, 0);
  for (const f of scanFrames(bytesOf, 0).frames) {
    prev = codec.link(
      f.sealed,
      { vault: VAULT, device: A, seg: MANIFEST_SEG, offset: f.offset },
      prev,
    );
  }
  return prev;
}
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

function setup() {
  const raw = new MemoryTransport();
  const writer = createOwnLogCarrier({ transport: raw, codec, gate, device: A });
  const reader = createOwnLogCarrier({
    transport: raw,
    codec: signers.codecFor(B),
    gate,
    device: B,
  });
  return { raw, writer, reader };
}

/** What the reader sees: `seg:size` per exposed segment of A. */
async function view(reader: ReturnType<typeof setup>["reader"]): Promise<string[]> {
  return (await reader.list(VAULT))
    .filter((s) => s.device === A)
    .sort((x, y) => x.seg - y.seg)
    .map((s) => `${s.seg}:${s.size}`);
}

describe("own-log carrier (manifest gating)", () => {
  it("records a closed segment before the writer creates the next one, and hides segment 0", async () => {
    const { raw, writer, reader } = setup();
    await writer.append(VAULT, A, 1, 0, bytes(10));
    expect((await raw.list(VAULT)).map((s) => s.seg)).toEqual([1]);
    await writer.append(VAULT, A, 2, 0, bytes(4));
    const rawSegs = (await raw.list(VAULT)).map((s) => s.seg).sort();
    expect(rawSegs).toEqual([0, 1, 2]);
    expect(await view(reader)).toEqual(["1:10", "2:4"]);
    expect((await writer.list(VAULT)).map((s) => s.seg).sort()).toEqual([1, 2]);
    expect((await reader.read(VAULT, A, MANIFEST_SEG, 0)).length).toBe(0);
    await expect(writer.append(VAULT, A, MANIFEST_SEG, 0, bytes(1))).rejects.toThrow(RangeError);
    // Idempotent: re-closing at the same size writes no second record.
    const before = (await raw.list(VAULT)).find((s) => s.seg === 0)?.size;
    await writer.append(VAULT, A, 3, 0, bytes(1));
    const manifest = (await raw.list(VAULT)).find((s) => s.seg === 0)?.size ?? 0;
    expect(manifest).toBeGreaterThan(before ?? 0);
  });

  it("holds a later segment while an earlier one is missing, incomplete or not yet closed", async () => {
    const { raw, writer, reader } = setup();
    await writer.append(VAULT, A, 1, 0, bytes(10));
    await writer.append(VAULT, A, 2, 0, bytes(10, 2));
    await writer.append(VAULT, A, 3, 0, bytes(10, 3));
    const full = new MemoryTransport();
    for (const s of await raw.list(VAULT)) {
      await full.append(VAULT, s.device, s.seg, 0, await raw.read(VAULT, s.device, s.seg, 0));
    }

    // Eventual storage: copy pieces of A's log into what B sees.
    const partial = new MemoryTransport();
    const seen = createOwnLogCarrier({ transport: partial, codec, gate, device: B });
    const copy = async (seg: number, upTo?: number) => {
      const all = await full.read(VAULT, A, seg, 0);
      const have =
        (await partial.list(VAULT)).find((s) => s.device === A && s.seg === seg)?.size ?? 0;
      await partial.append(VAULT, A, seg, have, all.subarray(have, upTo ?? all.length));
    };
    await copy(3);
    expect(await view(seen)).toEqual([]);
    expect(seen.status(VAULT)[0]?.held).toEqual({ seg: 1, reason: "missing" });
    await copy(1, 6); // segment 1 still downloading
    await copy(2);
    expect(await view(seen)).toEqual(["1:6"]);
    expect(seen.status(VAULT)[0]?.held).toEqual({ seg: 2, reason: "awaiting-manifest" });
    await copy(MANIFEST_SEG);
    expect(await view(seen)).toEqual(["1:6"]);
    expect(seen.status(VAULT)[0]?.held).toEqual({ seg: 2, reason: "incomplete" });
    expect((await seen.read(VAULT, A, 2, 0)).length).toBe(0);
    await copy(1);
    expect(await view(seen)).toEqual(["1:10", "2:10", "3:10"]);
    expect(seen.status(VAULT)[0]?.held).toBeUndefined();
    expect(seen.status(VAULT)[0]?.exposed).toEqual({ seg: 3, size: 10 });
    expect(await view(reader)).toEqual(["1:10", "2:10", "3:10"]);
  });

  it("caps a closed segment at its recorded size and reports the overrun", async () => {
    const { raw, writer, reader } = setup();
    await writer.append(VAULT, A, 1, 0, bytes(10));
    await writer.append(VAULT, A, 2, 0, bytes(3));
    await raw.append(VAULT, A, 1, 10, bytes(5, 9)); // storage (or a broken writer) grew segment 1
    expect(await view(reader)).toEqual(["1:10", "2:3"]);
    expect((await reader.read(VAULT, A, 1, 8)).length).toBe(2);
    expect(reader.status(VAULT)[0]?.overrun).toEqual([1]);
  });

  it("stops at a manifest record that does not verify, and at conflicting records", async () => {
    const { raw, writer, reader } = setup();
    await writer.append(VAULT, A, 1, 0, bytes(10));
    // A forged "closed" record sealed for another position.
    const forged = frameBytes(
      (
        await codec.seal(
          encodeRecord({ kind: "closed", seg: 1, size: 4 }),
          { vault: VAULT, device: A, seg: MANIFEST_SEG, offset: 999 },
          codec.genesis(VAULT, A, 0),
        )
      ).sealed,
    );
    await raw.append(VAULT, A, MANIFEST_SEG, 0, forged);
    await raw.append(VAULT, A, 2, 0, bytes(3));
    expect(await view(reader)).toEqual(["1:10"]);
    expect(reader.status(VAULT)[0]).toMatchObject({
      held: { seg: 2, reason: "awaiting-manifest" },
      manifestRejected: { offset: 0, code: "auth_failed" },
    });

    const second = setup();
    await second.writer.append(VAULT, A, 1, 0, bytes(10));
    await second.writer.append(VAULT, A, 2, 0, bytes(3));
    const size = (await second.raw.list(VAULT)).find((s) => s.seg === 0)?.size ?? 0;
    const conflicting = frameBytes(
      (
        await codec.seal(
          encodeRecord({ kind: "closed", seg: 1, size: 7 }),
          { vault: VAULT, device: A, seg: MANIFEST_SEG, offset: size },
          await manifestChain(second.raw),
        )
      ).sealed,
    );
    await second.raw.append(VAULT, A, MANIFEST_SEG, size, conflicting);
    expect(await view(second.reader)).toEqual([]);
    expect(second.reader.status(VAULT)[0]?.held).toEqual({ seg: 1, reason: "conflict" });
    const err = await second.writer.append(VAULT, A, 2, 3, bytes(1)).catch((e) => e);
    expect(err).toBeUndefined();
  });

  it("a manifest record a key holder signed for another writer is rejected (S29c B2)", async () => {
    const { raw, writer, reader } = setup();
    await writer.append(VAULT, A, 1, 0, bytes(10));
    // Sealed with the vault's data key at A's real position, but signed by a key nobody certified.
    const impostor = createOwnLogCodec({ sodium, ring, signer: createDeviceIdentity(sodium, A) });
    const record = await impostor.seal(
      encodeRecord({ kind: "closed", seg: 1, size: 4 }),
      { vault: VAULT, device: A, seg: MANIFEST_SEG, offset: 0 },
      impostor.genesis(VAULT, A, 0),
    );
    await raw.append(VAULT, A, MANIFEST_SEG, 0, frameBytes(record.sealed));
    await raw.append(VAULT, A, 2, 0, bytes(3));
    expect(await view(reader)).toEqual(["1:10"]);
    expect(reader.status(VAULT)[0]).toMatchObject({
      held: { seg: 2, reason: "awaiting-manifest" },
      manifestRejected: { offset: 0, code: "bad_head_signature" },
    });
  });

  it("refuses to create a segment whose predecessor does not exist", async () => {
    const { writer } = setup();
    const err = await writer.append(VAULT, A, 2, 0, bytes(1)).catch((e) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe("offset-conflict");
  });

  it("compaction hooks: snapshot markers, retired segments, resume after a snapshot", async () => {
    const { raw, writer } = setup();
    for (let seg = 1; seg <= 4; seg++) await writer.append(VAULT, A, seg, 0, bytes(8, seg));
    await writer.markSnapshot(VAULT, { seg: 3, offset: 8 }, "snap-2026-10-31.v1");
    await writer.retireBefore(VAULT, 3);
    await expect(writer.markSnapshot(VAULT, { seg: 3, offset: 8 }, "bad ref")).rejects.toThrow();
    // Storage without segments 1 and 2 (removed by a future S32 compaction).
    const compacted = new MemoryTransport();
    for (const s of await raw.list(VAULT)) {
      if (s.seg === 1 || s.seg === 2) continue;
      await compacted.append(VAULT, A, s.seg, 0, await raw.read(VAULT, A, s.seg, 0));
    }
    const fresh = createOwnLogCarrier({ transport: compacted, codec, gate, device: B });
    expect(await fresh.list(VAULT)).toEqual([]);
    expect(fresh.status(VAULT)[0]).toMatchObject({
      held: { seg: 1, reason: "compacted" },
      retiredBefore: 3,
      snapshots: [{ at: { seg: 3, offset: 8 }, ref: "snap-2026-10-31.v1" }],
    });
    expect(await fresh.snapshots(VAULT, A)).toEqual([
      { at: { seg: 3, offset: 8 }, ref: "snap-2026-10-31.v1" },
    ]);
    const resumed = createOwnLogCarrier({
      transport: compacted,
      codec,
      gate,
      device: B,
      resumeFrom: (_vault, device) => (device === A ? { seg: 3, offset: 8 } : undefined),
    });
    expect((await resumed.list(VAULT)).map((s) => `${s.seg}:${s.size}`).sort()).toEqual([
      "3:8",
      "4:8",
    ]);
  });
});
