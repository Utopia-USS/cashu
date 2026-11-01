// No key or plaintext reaches logs: the crypto layer writes nothing to the console or stdio, and
// every object a caller might log by mistake (secrets, rings, key pairs, errors) prints redacted.

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromUtf8, toBase64, toHex } from "./encoding.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity } from "./identity.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { loadKeyring, saveKeyring } from "./keystore.js";
import { createRecoveryKey, type NewRecoveryKey, recoveryIdentity } from "./recovery.js";
import { InMemoryKeyStore } from "./testing.js";
import {
  anyEpoch,
  ctx,
  PLAINTEXT_MARKER,
  pairWith,
  samplePlain,
  sodium,
  trustedTo,
  writerOf,
} from "./testkit.js";
import { recoveryRecipient, unwrapKeys, wrapKeys } from "./wrap.js";

const written: string[] = [];

/**
 * The phrase leaks if its words appear in sequence. Single words are no signal: BIP39 words such as
 * "device", "length" or "object" occur in error messages, `inspect` output and stack traces.
 */
function phraseFragments(phrase: string): string[] {
  const words = phrase.split(" ");
  return [phrase, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
}

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
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const c = ctx(ring.vaultId);
    const phone = createDeviceIdentity(sodium);
    rotateKeyring(sodium, ring);
    const frame = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;
    const phoneRing = pairWith(sodium, ring, phone);
    openFrame(sodium, phoneRing, frame, c).plain;
    const store = new InMemoryKeyStore();
    await saveKeyring(store, ring);
    await loadKeyring(store, sodium, ring.vaultId);
    const restoring = recoveryIdentity(sodium, recovery.phrase);
    unwrapKeys(
      sodium,
      wrapKeys(sodium, ring, restoring, recoveryRecipient(ring)),
      restoring,
      { vaultId: ring.vaultId, recoveryPublicKey: recovery.publicKeys },
      () => restoring.signPublicKey,
      anyEpoch,
    );
    const tampered = frame.slice();
    tampered[tampered.length - 65] = (tampered.at(-65) ?? 0) ^ 1; // the AEAD tag
    expect(() => openFrame(sodium, ring, tampered, c).plain).toThrow();
    expect(() => recoveryIdentity(sodium, `${recovery.phrase.reveal()} extra`)).toThrow();
    expect(written).toEqual([]);
  });

  it("logging secrets, rings, key pairs and errors by mistake shows no key bytes, words or plaintext", () => {
    const recovery = createRecoveryKey(sodium);
    const { output, secrets, opened } = logEverything(recovery);
    for (const f of [...secrets, PLAINTEXT_MARKER]) expect(output).not.toContain(f);
    expect(fromUtf8(opened)).toContain(PLAINTEXT_MARKER);

    // Fixed text holds BIP39 word pairs too ("wrong key", "this device", "word phrase"), so a
    // random phrase sometimes shares one with it. A pair is a leak only if it is missing from the
    // same output rendered for another phrase that shares no pair with this one.
    const fragments = phraseFragments(recovery.phrase.reveal());
    const baseline = logEverything(recoveryKeySharingNoPair(fragments)).output;
    expect(fragments.filter((f) => output.includes(f) && !baseline.includes(f))).toEqual([]);
  });
});

/** Another recovery key whose phrase has none of the given word pairs. */
function recoveryKeySharingNoPair(fragments: readonly string[]): NewRecoveryKey {
  for (;;) {
    const other = createRecoveryKey(sodium);
    if (!phraseFragments(other.phrase.reveal()).some((f) => fragments.includes(f))) return other;
  }
}

/**
 * Logs by mistake everything a caller holds after a flow with `recovery` (rings, key pairs, errors,
 * in every way a value turns into text) and returns that text, the encodings of every secret, and
 * a frame opened with the ring.
 */
function logEverything(recovery: NewRecoveryKey): {
  output: string;
  secrets: string[];
  opened: Uint8Array;
} {
  const ring = createKeyring(sodium, recovery.publicKeys);
  rotateKeyring(sodium, ring);
  const pair = createDeviceIdentity(sodium);
  const recoveryPair = recoveryIdentity(sodium, recovery.phrase);
  const c = ctx(ring.vaultId);
  const frame = sealFrame(sodium, ring, samplePlain(), c, writerOf(c)).bytes;

  const errors: unknown[] = [];
  for (const fn of [
    () =>
      openFrame(sodium, createKeyring(sodium, recovery.publicKeys, ring.vaultId), frame, c).plain,
    () => openFrame(sodium, ring, frame.subarray(0, frame.length - 1), c).plain,
    () => recoveryIdentity(sodium, recovery.phrase.reveal().split(" ").slice(0, 23).join(" ")),
    () =>
      unwrapKeys(
        sodium,
        wrapKeys(sodium, ring, pair, trustedTo(pair, ring.vaultId)),
        recoveryPair,
        ring,
        () => pair.signPublicKey,
        anyEpoch,
      ),
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

  const secrets = [
    ...ring.entries().flatMap((e) => secretsOf(e.key.expose())),
    ...ring.entries().flatMap((e) => secretsOf(e.frameKey.expose())),
    ...secretsOf(ring.gidSalt().expose()),
    ...secretsOf(pair.box.secretKey.expose()),
    ...secretsOf(pair.signSecretKey.expose()),
    ...secretsOf(recoveryPair.box.secretKey.expose()),
    ...secretsOf(recoveryPair.signSecretKey.expose()),
  ];
  return { output, secrets, opened: openFrame(sodium, ring, frame, c).plain };
}
