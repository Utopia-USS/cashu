// The self-test on Node with libsodium-wrappers and an in-memory secure store and files: every check
// passes, a broken library fails the known-answer test, and a KeyStore that loses values is caught.
// The device run (debug screen) uses react-native-libsodium, expo-secure-store and real files.
import type { crypto } from "@cashu/sync";
import { runCryptoSelfTest } from "./cryptoSelfTest";
import { runtime as lib, memoryKeyStore, withOpenFailure } from "./testing/runtime";

describe("crypto self-test", () => {
  it.each([
    ["iOS", () => new Error("incorrect key pair for the given ciphertext")],
    ["Android", () => new Error("Exception in HostFunction: native failure\n\nError: JSI stack")],
    ["new binding wording", () => new Error("a completely different authentication error")],
  ])(
    "uses classified failure kinds for %s without matching messages",
    async (_platform, failure) => {
      const r = await runCryptoSelfTest({
        lib: withOpenFailure(await lib(), failure),
        keyStore: memoryKeyStore,
      });
      expect(r.ok).toBe(true);
      expect(r.checks.find((check) => check.name === "sealedBoxWrongKey")).toEqual({
        name: "sealedBoxWrongKey",
        ok: true,
      });
    },
  );

  it.each([
    ["TypeError", () => new TypeError("synthetic backend detail")],
    ["object", () => ({ message: "synthetic backend detail" })],
  ])(
    "fails closed on an unknown %s error shape without exposing backend details",
    async (_kind, failure) => {
      const r = await runCryptoSelfTest({
        lib: withOpenFailure(await lib(), failure),
        keyStore: memoryKeyStore,
      });
      expect(r).toEqual({
        ok: false,
        nativeAead: "not_run",
        checks: [{ name: "knownAnswer", ok: false, code: "unsupported_runtime" }],
      });
    },
  );

  it("never reports a backend that throws on every open as a working runtime", async () => {
    const real = await lib();
    const r = await runCryptoSelfTest({
      lib: {
        ...real,
        crypto_box_seal_open: () => {
          throw new Error("synthetic backend detail");
        },
      },
      keyStore: memoryKeyStore,
    });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([{ name: "knownAnswer", ok: false, code: "unsupported_runtime" }]);
  });

  it("passes every check on a working runtime", async () => {
    const r = await runCryptoSelfTest({ lib: await lib(), keyStore: memoryKeyStore });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual([
      "knownAnswer",
      "vault",
      "frame",
      "frameTamper",
      "sealedBox",
      "sealedBoxWrongKey",
      "keyStore",
    ]);
    expect(r.ok).toBe(true);
    expect(r.nativeAead).toBe("supported");
  });

  it("cross-checks the native Ed25519 verification against @noble", async () => {
    const real = await lib();
    const signLib = real as unknown as crypto.LibsodiumSignLike;
    const r = await runCryptoSelfTest({ lib: real, signLib, keyStore: memoryKeyStore });
    expect(r.ok).toBe(true);
    expect(r.checks.at(-1)).toEqual({ name: "nativeVerify", ok: true });
    // A native verify that accepts a changed signature disagrees with @noble.
    const lenient: crypto.LibsodiumSignLike = {
      crypto_sign_verify_detached: (sig, msg, pk) =>
        signLib.crypto_sign_verify_detached(sig, msg, pk) ||
        signLib.crypto_sign_verify_detached(
          Uint8Array.from(sig, (b, i) => (i === 18 ? b ^ 1 : b)),
          msg,
          pk,
        ),
    };
    const loose = await runCryptoSelfTest({
      lib: real,
      signLib: lenient,
      keyStore: memoryKeyStore,
    });
    expect(loose.ok).toBe(false);
    expect(loose.checks.at(-1)).toEqual({ name: "nativeVerify", ok: false, code: "mismatch" });
    // One that skips the small-order key check fails (its known answers already catch it).
    const smallOrder = await runCryptoSelfTest({
      lib: real,
      signLib: {
        crypto_sign_verify_detached: (sig, msg, pk) =>
          (pk[0] === 1 && pk.subarray(1).every((b) => b === 0)) ||
          signLib.crypto_sign_verify_detached(sig, msg, pk),
      },
      keyStore: memoryKeyStore,
    });
    expect(smallOrder.ok).toBe(false);
    expect(smallOrder.checks.at(-1)).toMatchObject({ name: "nativeVerify", ok: false });
    // One that fails its known answers is a runtime fault.
    const dead = await runCryptoSelfTest({
      lib: real,
      signLib: { crypto_sign_verify_detached: () => false },
      keyStore: memoryKeyStore,
    });
    expect(dead.checks.at(-1)).toEqual({
      name: "nativeVerify",
      ok: false,
      code: "unsupported_runtime",
    });
  });

  it("fails closed when a primitive is broken", async () => {
    const real = await lib();
    const broken = { ...real, crypto_generichash: () => new Uint8Array(32) };
    const r = await runCryptoSelfTest({ lib: broken, keyStore: memoryKeyStore });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([
      {
        name: "knownAnswer",
        ok: false,
        code: "unsupported_runtime",
      },
    ]);
  });

  it("catches a KeyStore that does not keep values", async () => {
    const forgetful = (): crypto.KeyStore => ({
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    });
    const r = await runCryptoSelfTest({ lib: await lib(), keyStore: forgetful });
    expect(r.checks.find((c) => c.name === "keyStore")).toEqual({
      name: "keyStore",
      ok: false,
      code: "mismatch",
    });
  });

  it.each(["factory", "get", "set", "delete"] as const)(
    "classifies a plain KeyStore %s failure separately from the crypto runtime",
    async (operation) => {
      const r = await runCryptoSelfTest({
        lib: await lib(),
        keyStore: (sodium) => {
          const fail = async () => {
            throw new Error("synthetic storage detail");
          };
          if (operation === "factory") throw new Error("synthetic storage detail");
          return { ...memoryKeyStore(sodium), [operation]: fail };
        },
      });
      expect(r.ok).toBe(false);
      expect(r.nativeAead).toBe("supported");
      expect(r.checks.filter((c) => !c.ok)).toEqual([
        { name: "keyStore", ok: false, code: "keystore_unavailable" },
      ]);
    },
  );
});
