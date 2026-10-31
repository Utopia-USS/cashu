// No key or plaintext reaches logs: the crypto layer writes nothing to the console or stdio, and
// every object a caller might log by mistake (secrets, rings, key pairs, errors) prints redacted.

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromUtf8, toBase64, toHex } from "./encoding.js";
import { openFrame, sealFrame } from "./frame.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { InMemoryKeyStore, loadKeyring, saveKeyring } from "./keystore.js";
import { createRecoveryKey, recoveryKeyPair } from "./recovery.js";
import { ctx, PLAINTEXT_MARKER, samplePlain, sodium } from "./testkit.js";
import { createDeviceKeyPair, unwrapKeys, wrapKeys } from "./wrap.js";

const written: string[] = [];

beforeEach(() => {
  written.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      written.push(args.map((a) => inspect(a)).join(" "));
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function secretsOf(bytes: Uint8Array): string[] {
  return [
    toHex(bytes),
    toBase64(bytes),
    Buffer.from(bytes).toString("base64url"),
    [...bytes].join(","),
  ];
}

describe("no key or plaintext in logs", () => {
  it("a full flow (create, seal, rotate, pair, store, recover, tamper) writes nothing", async () => {
    const ring = createKeyring(sodium);
    const c = ctx(ring.vaultId);
    const phone = createDeviceKeyPair(sodium);
    const recovery = createRecoveryKey(sodium);
    rotateKeyring(sodium, ring);
    const frame = sealFrame(sodium, ring, samplePlain(), c);
    const phoneRing = unwrapKeys(
      sodium,
      wrapKeys(sodium, ring, phone.publicKey),
      phone,
      ring.vaultId,
    );
    openFrame(sodium, phoneRing, frame, c);
    const store = new InMemoryKeyStore();
    await saveKeyring(store, ring);
    await loadKeyring(store, sodium, ring.vaultId);
    unwrapKeys(
      sodium,
      wrapKeys(sodium, ring, recovery.publicKey),
      recoveryKeyPair(sodium, recovery.phrase),
      ring.vaultId,
    );
    const tampered = frame.slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => openFrame(sodium, ring, tampered, c)).toThrow();
    expect(() => recoveryKeyPair(sodium, `${recovery.phrase} extra`)).toThrow();
    expect(written).toEqual([]);
  });

  it("logging secrets, rings, key pairs and errors by mistake shows no key bytes, words or plaintext", () => {
    const ring = createKeyring(sodium);
    rotateKeyring(sodium, ring);
    const pair = createDeviceKeyPair(sodium);
    const recovery = createRecoveryKey(sodium);
    const recoveryPair = recoveryKeyPair(sodium, recovery.phrase);
    const c = ctx(ring.vaultId);
    const frame = sealFrame(sodium, ring, samplePlain(), c);

    const errors: unknown[] = [];
    for (const fn of [
      () => openFrame(sodium, createKeyring(sodium, ring.vaultId), frame, c),
      () => openFrame(sodium, ring, frame.subarray(0, frame.length - 1), c),
      () => recoveryKeyPair(sodium, recovery.phrase.split(" ").slice(0, 23).join(" ")),
      () => unwrapKeys(sodium, wrapKeys(sodium, ring, pair.publicKey), recoveryPair, ring.vaultId),
    ]) {
      try {
        fn();
      } catch (e) {
        errors.push(e);
      }
    }
    expect(errors).toHaveLength(4);

    const things: unknown[] = [ring, ring.active, ring.entries(), pair, recoveryPair, ...errors];
    const output = things
      .flatMap((t) => [
        inspect(t, { depth: 10, showHidden: true }),
        JSON.stringify(t),
        String(t),
        `${t}`,
      ])
      .concat(errors.map((e) => `${(e as Error).message}\n${(e as Error).stack ?? ""}`))
      .join("\n");

    const forbidden = [
      ...ring.entries().flatMap((e) => secretsOf(e.key.expose())),
      ...secretsOf(pair.secretKey.expose()),
      ...secretsOf(recoveryPair.secretKey.expose()),
      ...recovery.phrase.split(" ").filter((w) => w.length >= 5),
      PLAINTEXT_MARKER,
    ];
    for (const f of forbidden) expect(output).not.toContain(f);
    expect(fromUtf8(openFrame(sodium, ring, frame, c))).toContain(PLAINTEXT_MARKER);
  });
});
