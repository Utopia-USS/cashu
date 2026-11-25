// The device's database key over an in-memory secure store: created once with the KeyStore's Keychain
// options, reused, raw-key hex shape, deleted by the wipe. Synthetic randomness only.
import { memorySecureStore } from "../selftest/testing/runtime";
import { createDbKey, DB_KEY_ITEM } from "./dbKey";

const counting = () => {
  let calls = 0;
  const random = (n: number) => {
    calls++;
    return Uint8Array.from({ length: n }, (_, i) => (i * 7 + calls) & 0xff);
  };
  return { random, calls: () => calls };
};

describe("database key", () => {
  it("is created once as 64 hex characters in the cashu service, then reused", () => {
    const store = memorySecureStore();
    const rng = counting();
    const key = createDbKey(store, rng.random);
    expect(key.exists()).toBe(false);
    const first = key.loadOrCreate();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(store.items.get(`cashu/${DB_KEY_ITEM}`)).toBe(first);
    expect(key.exists()).toBe(true);
    expect(key.loadOrCreate()).toBe(first);
    expect(createDbKey(store, rng.random).loadOrCreate()).toBe(first);
    expect(rng.calls()).toBe(1);
  });

  it("is written readable after the first unlock, never biometric-gated", () => {
    const writes: unknown[] = [];
    const store = memorySecureStore();
    const key = createDbKey(
      {
        ...store,
        setItem: (k, v, options) => {
          writes.push(options);
          store.setItem(k, v, options);
        },
      },
      counting().random,
    );
    key.loadOrCreate();
    expect(writes).toEqual([{ keychainService: "cashu", keychainAccessible: 7 }]);
  });

  it("is gone after delete, and a new one differs", async () => {
    const store = memorySecureStore();
    const key = createDbKey(store, counting().random);
    const first = key.loadOrCreate();
    await key.delete();
    expect(key.exists()).toBe(false);
    await key.delete();
    expect(key.loadOrCreate()).not.toBe(first);
  });

  it("refuses a stored value that is not a raw key", () => {
    const store = memorySecureStore();
    store.setItem(DB_KEY_ITEM, "x'00'; ATTACH", { keychainService: "cashu" });
    expect(() => createDbKey(store, counting().random).loadOrCreate()).toThrow("db_key_corrupt");
  });

  it("refuses short randomness", () => {
    const key = createDbKey(memorySecureStore(), (n) => new Uint8Array(n - 1));
    expect(() => key.loadOrCreate()).toThrow("db_key_random_failed");
  });
});
