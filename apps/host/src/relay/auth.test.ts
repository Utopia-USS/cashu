// The relay identity's keychain record: a stored value that does not decode reads as absent (the next
// request signs up afresh), and only the uid and the refresh token are ever written. Synthetic values
// only; the identity endpoint is the in-memory fake.
import type { RelayAuthSecret } from "@cashu/node-host/relay-auth";
import { createFakeFirebase } from "@cashu/sync/testing";
import { expect, it } from "vitest";
import { relayIdentity, secretAuthStore } from "./auth.js";

function memorySecret(initial: string | null): RelayAuthSecret & { readonly value: string | null } {
  let value = initial;
  return {
    get value() {
      return value;
    },
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
}

const VALID = { uid: "syntheticUid_01", refreshToken: "synthetic-refresh-token" };

it("decodes a stored record and reads anything else as absent", async () => {
  expect(await secretAuthStore(memorySecret(null)).load()).toBeUndefined();
  expect(await secretAuthStore(memorySecret(JSON.stringify(VALID))).load()).toEqual(VALID);
  for (const stored of [
    "not json",
    "null",
    JSON.stringify([VALID]),
    JSON.stringify({ ...VALID, extra: "key" }),
    JSON.stringify({ uid: "has/slash", refreshToken: "t" }),
    JSON.stringify({ uid: "u", refreshToken: "" }),
    JSON.stringify({ uid: "u" }),
  ])
    expect(await secretAuthStore(memorySecret(stored)).load()).toBeUndefined();
});

it("writes only the uid and the refresh token, and clears", async () => {
  const secret = memorySecret(null);
  const store = secretAuthStore(secret);
  await store.save({ ...VALID, idToken: "never stored" } as typeof VALID);
  expect(JSON.parse(secret.value ?? "")).toEqual(VALID);
  await store.clear();
  expect(secret.value).toBeNull();
});

it("signs up afresh over a record that does not decode and stores the new one", async () => {
  const fake = createFakeFirebase();
  const secret = memorySecret("{ broken");
  const identity = relayIdentity({
    endpoint: fake.identity,
    store: secretAuthStore(secret),
    fetch: fake.fetch,
    now: () => Date.UTC(2026, 10, 14),
    onIdentityLost: () => {
      throw new Error("a fresh sign-up is not an identity loss");
    },
  });
  const uid = await identity.uid();
  expect(fake.counters.signUp).toBe(1);
  expect(await secretAuthStore(secret).load()).toMatchObject({ uid });
});
