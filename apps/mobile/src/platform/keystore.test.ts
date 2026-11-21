// The KeyStore's blob files are replaced atomically: a write killed at any step (inside the in-place
// write of the new bytes, or between the renames) leaves the old value readable through the real
// sealed KeyStore, and the next write cleans up. A fake disk stands in for expo-file-system; the
// sealing is the real one. Synthetic values only.
import { crypto } from "@cashu/sync/engine";
import { runtime } from "../selftest/testing/runtime";
import { atomicBlobFiles, type BlobDisk } from "./keystore";

jest.mock("expo-file-system", () => ({}));
jest.mock("expo-secure-store", () => ({}));

class Killed extends Error {}

/** A disk in memory; `killAt` throws at that operation (a write is torn: half its bytes land first). */
function fakeDisk() {
  const files = new Map<string, Uint8Array>();
  let ops = 0;
  let killAt = Number.POSITIVE_INFINITY;
  const step = () => {
    if (ops++ === killAt) throw new Killed();
  };
  const disk: BlobDisk = {
    exists: (file) => files.has(file),
    read: async (file) => {
      const bytes = files.get(file);
      if (bytes === undefined) throw new Error("no such file");
      return bytes.slice();
    },
    async write(file, value) {
      if (ops === killAt) {
        ops++;
        files.set(file, value.slice(0, value.length >> 1));
        throw new Killed();
      }
      step();
      files.set(file, value.slice());
    },
    rename(from, to) {
      step();
      const bytes = files.get(from);
      if (bytes === undefined || files.has(to)) throw new Error("rename refused");
      files.delete(from);
      files.set(to, bytes);
    },
    remove(file) {
      step();
      files.delete(file);
    },
  };
  return {
    files,
    disk,
    killAt(op: number) {
      ops = 0;
      killAt = op;
    },
    heal() {
      killAt = Number.POSITIVE_INFINITY;
    },
  };
}

let sodium: crypto.Sodium;
beforeAll(async () => {
  sodium = crypto.fromLibsodium(await runtime(), { aead: "noble" });
});

function keyStoreOver(disk: BlobDisk, items: Map<string, string>): crypto.KeyStore {
  return crypto.createSecureStoreKeyStore(
    sodium,
    {
      getItemAsync: async (key) => items.get(key) ?? null,
      setItemAsync: async (key, value) => void items.set(key, value),
      deleteItemAsync: async (key) => void items.delete(key),
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
    },
    atomicBlobFiles(disk),
  );
}

const NAME = "cashu.vault.synthetic.keys";
const OLD = new TextEncoder().encode("old synthetic value");
const NEW = new TextEncoder().encode("new synthetic value, longer than the old one");

describe("atomicBlobFiles", () => {
  it("keeps the old value readable when a write is killed at any step", async () => {
    // Steps of one replacing write: the tmp write, current -> old, tmp -> current, delete old.
    for (let op = 0; op < 4; op++) {
      const fake = fakeDisk();
      const items = new Map<string, string>();
      await keyStoreOver(fake.disk, items).set(NAME, OLD);
      fake.killAt(op);
      await expect(keyStoreOver(fake.disk, items).set(NAME, NEW)).rejects.toBeInstanceOf(Killed);
      fake.heal();
      // The next launch: a new KeyStore over the same disk and Keychain.
      const read = await keyStoreOver(fake.disk, items).get(NAME);
      // Killed before the new value was renamed in: the old one; after it: the new one.
      expect(read).toEqual(op < 3 ? OLD : NEW);
      // The next write cleans up what the killed one left and lands alone.
      await keyStoreOver(fake.disk, items).set(NAME, NEW);
      expect(await keyStoreOver(fake.disk, items).get(NAME)).toEqual(NEW);
      expect([...fake.files.keys()]).toEqual([`${NAME}.bin`]);
    }
  });

  it("reads a first write killed before it landed as absent, never as a torn value", async () => {
    for (let op = 0; op < 2; op++) {
      const fake = fakeDisk();
      const items = new Map<string, string>();
      fake.killAt(op);
      await expect(keyStoreOver(fake.disk, items).set(NAME, NEW)).rejects.toBeInstanceOf(Killed);
      fake.heal();
      expect(await keyStoreOver(fake.disk, items).get(NAME)).toBeNull();
    }
  });

  it("removes every file of a name", async () => {
    const fake = fakeDisk();
    const files = atomicBlobFiles(fake.disk);
    await files.write(NAME, OLD);
    fake.files.set(`${NAME}.bin.tmp`, NEW);
    await files.remove(NAME);
    expect(fake.files.size).toBe(0);
    expect(await files.read(NAME)).toBeNull();
  });
});
