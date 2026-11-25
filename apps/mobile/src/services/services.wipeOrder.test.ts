// "Remove this phone" killed at every point, then launched again: nothing the wipe was removing can be
// read afterwards. A fake phone stands in for the Keychain and the documents folder; the wipe runs
// through the real `wipeDevice` order with the real `deletePhoneSecrets`, the next launch through the
// real `discardWithoutDbKey` (services.ts binds both to expo). The oracle is the fake phone's state:
// the old databases are readable while their files and the old database key are both there, the
// sealed values while `keys/` and the old key-encryption key are both there. Synthetic values only.
import {
  deletePhoneSecrets,
  discardWithoutDbKey,
  type PhoneSecretItems,
  type WipeLeftovers,
} from "../platform/keystore";
import { type WipeSteps, wipeDevice } from "./wipe";

jest.mock("expo-file-system", () => ({}));
jest.mock("expo-secure-store", () => ({}));

/** The phone in use before the wipe: both keys, databases, sealed values and the other app files. */
function fakePhone() {
  return {
    dbKey: "old" as "old" | "new" | null,
    kek: "old" as "old" | "new" | null,
    databases: ["device.db", "log-v1.db", "view-v1.db", "market.db"],
    keys: true,
    bench: true,
    languagePin: true,
  };
}
type Phone = ReturnType<typeof fakePhone>;

/** The wipe's destructive operations, in the order services.ts runs them. */
const WIPE_OPS = [
  "deleteDbKey",
  "deleteKek",
  "deleteKeyStoreFiles",
  "deleteBenchLogs",
  "deleteLanguagePin",
  "deleteDatabaseFiles",
] as const;

/**
 * Run the wipe on `phone` and kill the process before operation `killAt` (WIPE_OPS index): from then on
 * nothing runs any more (an async step never settles, a sync one does nothing).
 */
async function wipeKilledAt(phone: Phone, killAt: number): Promise<string[]> {
  const ran: string[] = [];
  let dead = false;
  const op = (name: (typeof WIPE_OPS)[number], effect: () => void): boolean => {
    if (dead || WIPE_OPS.indexOf(name) === killAt) {
      dead = true;
      return false;
    }
    effect();
    ran.push(name);
    return true;
  };
  const asyncOp = (name: (typeof WIPE_OPS)[number], effect: () => void) => (): Promise<void> =>
    op(name, effect) ? Promise.resolve() : new Promise<void>(() => {});
  const items: PhoneSecretItems = {
    deleteDbKey: asyncOp("deleteDbKey", () => {
      phone.dbKey = null;
    }),
    deleteKek: asyncOp("deleteKek", () => {
      phone.kek = null;
    }),
  };
  const steps: WipeSteps = {
    showWiping: () => {},
    beforeWipe: [],
    deleteSecrets: () => deletePhoneSecrets(items),
    nextFrame: async () => {},
    close: () => {},
    deleteFiles: () => {
      op("deleteKeyStoreFiles", () => {
        phone.keys = false;
      });
      op("deleteBenchLogs", () => {
        phone.bench = false;
      });
      op("deleteLanguagePin", () => {
        phone.languagePin = false;
      });
      op("deleteDatabaseFiles", () => {
        phone.databases = [];
      });
    },
    reset: () => {},
    remount: () => {},
  };
  void wipeDevice(steps);
  // Let every step that can settle settle (a killed one never does).
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return ran;
}

/** The next launch's start: discard what has no database key, then create the key when missing. */
async function launch(phone: Phone): Promise<void> {
  const io: WipeLeftovers = {
    dbKeyExists: () => phone.dbKey !== null,
    databaseFiles: () => phone.databases,
    deleteDatabaseFiles: () => {
      phone.databases = [];
    },
    keyStoreFilesExist: () => phone.keys,
    deleteKeyStoreFiles: () => {
      phone.keys = false;
    },
    deleteKek: async () => {
      phone.kek = null;
    },
  };
  const left = discardWithoutDbKey(io);
  await left?.kek;
  phone.dbKey ??= "new";
}

const readableDatabases = (phone: Phone) => phone.databases.length > 0 && phone.dbKey === "old";
const readableSealed = (phone: Phone) => phone.keys && phone.kek === "old";

describe("an interrupted wipe", () => {
  it("is finished by the next launch whatever step the kill stopped at", async () => {
    for (let killAt = 1; killAt <= WIPE_OPS.length; killAt++) {
      const phone = fakePhone();
      const ran = await wipeKilledAt(phone, killAt);
      expect(ran).toEqual(WIPE_OPS.slice(0, killAt));
      await launch(phone);
      expect({ killAt, databases: readableDatabases(phone) }).toEqual({ killAt, databases: false });
      expect({ killAt, sealed: readableSealed(phone) }).toEqual({ killAt, sealed: false });
      expect({ killAt, kek: phone.kek }).toEqual({ killAt, kek: null });
      expect({ killAt, keys: phone.keys }).toEqual({ killAt, keys: false });
      expect(phone.databases).toEqual([]);
    }
  });

  it("killed before the first delete leaves the phone as it was (the wipe never started)", async () => {
    const phone = fakePhone();
    expect(await wipeKilledAt(phone, 0)).toEqual([]);
    await launch(phone);
    expect(phone).toEqual(fakePhone());
  });

  it("deletes the database key before the key-encryption key", async () => {
    const order: string[] = [];
    await deletePhoneSecrets({
      deleteDbKey: async () => void order.push("dbKey"),
      deleteKek: async () => void order.push("kek"),
    });
    expect(order).toEqual(["dbKey", "kek"]);
  });

  it("keeps the key-encryption key when the database key could not be deleted", async () => {
    const deleteKek = jest.fn(async () => {});
    await expect(
      deletePhoneSecrets({
        deleteDbKey: async () => {
          throw new Error("synthetic keychain failure");
        },
        deleteKek,
      }),
    ).rejects.toThrow("synthetic keychain failure");
    expect(deleteKek).not.toHaveBeenCalled();
  });
});

describe("the launch without a database key", () => {
  function leftovers(phone: Phone, kekDelete: () => Promise<void>): WipeLeftovers {
    return {
      dbKeyExists: () => phone.dbKey !== null,
      databaseFiles: () => phone.databases,
      deleteDatabaseFiles: () => {
        phone.databases = [];
      },
      keyStoreFilesExist: () => phone.keys,
      deleteKeyStoreFiles: () => {
        phone.keys = false;
      },
      deleteKek: kekDelete,
    };
  }

  it("deletes the databases and keys/ at once and hands back the key-encryption key's delete", async () => {
    const phone = { ...fakePhone(), dbKey: null };
    let finish: () => void = () => {};
    const kek = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const left = discardWithoutDbKey(leftovers(phone, () => kek));
    expect(left).toMatchObject({ databaseFiles: 4, keyStoreFiles: true });
    expect(phone.databases).toEqual([]);
    expect(phone.keys).toBe(false);
    let settled = false;
    void left?.kek.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await left?.kek;
    expect(settled).toBe(true);
  });

  it("removes keys/ even when the key-encryption key's delete never runs", async () => {
    const phone = { ...fakePhone(), dbKey: null, databases: [] };
    const left = discardWithoutDbKey(
      leftovers(phone, () => Promise.reject(new Error("synthetic keychain failure"))),
    );
    expect(phone.keys).toBe(false);
    await expect(left?.kek).rejects.toThrow("synthetic keychain failure");
    expect(readableSealed(phone)).toBe(false);
  });

  it("touches nothing while the database key exists, or when nothing was left", () => {
    const deleteKek = jest.fn(async () => {});
    const inUse = fakePhone();
    expect(discardWithoutDbKey(leftovers(inUse, deleteKek))).toBeUndefined();
    expect(inUse).toEqual(fakePhone());
    const fresh = { ...fakePhone(), dbKey: null, kek: null, databases: [], keys: false };
    expect(discardWithoutDbKey(leftovers(fresh, deleteKek))).toBeUndefined();
    expect(deleteKek).not.toHaveBeenCalled();
  });
});
