// The keyed open's statement order over a fake connection (expo-sqlite and SQLCipher exist only on the
// device): the key is the first statement, the cipher's presence is checked, plain SQLite throws, one
// probe read proves the key, a NOTADB answer is a key mismatch, and the boot's recovery discards the
// files and opens once more.
import {
  DEVICE_DB,
  deviceStoreMismatch,
  isDbKeyMismatch,
  keyDatabase,
  MARKET_DB,
  openBaseFiles,
  openVaultFiles,
  openWithKeyRecovery,
} from "./sqliteKeying";

const KEY = "0123456789abcdef".repeat(4);
const PROBE = "SELECT count(*) AS n FROM sqlite_master";

/** expo-sqlite's message for SQLITE_NOTADB. */
const NOTADB =
  "Calling the 'getFirstSync' function has failed\n→ Caused by: Error code 26: file is not a database";

function fakeDb(cipher: { cipher_version: string } | null, probe?: Error) {
  const calls: string[] = [];
  return {
    calls,
    execSync: (sql: string) => void calls.push(`exec ${sql}`),
    getFirstSync: <T>(sql: string): T | null => {
      calls.push(`get ${sql}`);
      if (sql === PROBE) {
        if (probe) throw probe;
        return { n: 0 } as T;
      }
      return cipher as T | null;
    },
  };
}

describe("keyed SQLite open", () => {
  it("runs PRAGMA key first, then checks the cipher version", () => {
    const db = fakeDb({ cipher_version: "4.17.0 community" });
    expect(keyDatabase(db, KEY)).toBe("4.17.0 community");
    expect(db.calls).toEqual([
      `exec PRAGMA key = "x'${KEY}'"`,
      "get PRAGMA cipher_version",
      `get ${PROBE}`,
    ]);
  });

  it("throws db_key_mismatch when the key does not open the file", () => {
    const db = fakeDb({ cipher_version: "4.17.0 community" }, new Error(NOTADB));
    let thrown: unknown;
    try {
      keyDatabase(db, KEY);
    } catch (error) {
      thrown = error;
    }
    expect(isDbKeyMismatch(thrown)).toBe(true);
  });

  it("passes any other failure of the probe through", () => {
    const db = fakeDb({ cipher_version: "4.17.0 community" }, new Error("disk I/O error"));
    expect(() => keyDatabase(db, KEY)).toThrow("disk I/O error");
  });

  it("throws on a binary without SQLCipher instead of running on plaintext", () => {
    const db = fakeDb(null);
    expect(() => keyDatabase(db, KEY)).toThrow("sqlcipher_unavailable");
  });

  it("never interpolates anything but 64 lowercase hex characters", () => {
    for (const bad of [KEY.toUpperCase(), KEY.slice(1), `${KEY}"; DROP`, ""]) {
      const db = fakeDb({ cipher_version: "4.17.0" });
      expect(() => keyDatabase(db, bad)).toThrow("db_key_invalid");
      expect(db.calls).toEqual([]);
    }
  });
});

describe("key mismatch recovery", () => {
  const mismatch = () => new Error("db_key_mismatch: the key does not open this file");

  it("discards every file and opens once more on a key mismatch", () => {
    const log: string[] = [];
    let first = true;
    const opened = openWithKeyRecovery(
      () => {
        log.push("open");
        if (first) {
          first = false;
          throw mismatch();
        }
        return "services";
      },
      () => void log.push("discard"),
    );
    expect(opened).toBe("services");
    expect(log).toEqual(["open", "discard", "open"]);
  });

  it("discards nothing on any other failure", () => {
    const log: string[] = [];
    expect(() =>
      openWithKeyRecovery(
        () => {
          throw new Error("sqlcipher_unavailable");
        },
        () => void log.push("discard"),
      ),
    ).toThrow("sqlcipher_unavailable");
    expect(log).toEqual([]);
  });

  it("throws a second mismatch instead of looping", () => {
    let opens = 0;
    expect(() =>
      openWithKeyRecovery(
        () => {
          opens++;
          throw mismatch();
        },
        () => {},
      ),
    ).toThrow("db_key_mismatch");
    expect(opens).toBe(2);
  });
});

// Per-file decisions over a fake disk: each file remembers the key it was written under; opening it
// under another key is a mismatch, opening a missing file creates it under the current key.
const DEMO = "ca000000000000000000000000000a11";
const PAIRED = "5f0c3a9e81d24b7690ae13c7d2f4b856";

function fakeDisk(files: Record<string, string>, key: string) {
  const disk = new Map(Object.entries(files));
  const reports: [string, number][] = [];
  const open = (file: string) => {
    const held = disk.get(file);
    if (held !== undefined && held !== key)
      throw new Error("db_key_mismatch: the key does not open this file");
    disk.set(file, key);
    return { file, close: () => {} };
  };
  return {
    disk,
    reports,
    open,
    ports: {
      openDevice: () => open(DEVICE_DB),
      openPrices: () => open(MARKET_DB),
      files: () => [...disk.keys()],
      opens: (file: string) =>
        file.startsWith("log-") || file === MARKET_DB ? disk.get(file) === key : false,
      remove: (file: string) => void disk.delete(file),
      isDemo: (vault: string) => vault === DEMO,
      report: (reason: string, n: number) => void reports.push([reason, n]),
    },
  };
}

describe("per-file key mismatch", () => {
  const all = (k: string) => ({
    [DEVICE_DB]: k,
    [MARKET_DB]: k,
    [`vault-${DEMO}.db`]: k,
    [`log-${DEMO}.db`]: k,
    [`vault-${PAIRED}.db`]: k,
    [`log-${PAIRED}.db`]: k,
  });

  it("recreates a market cache the key does not open, and only it", () => {
    const fake = fakeDisk({ ...all("K"), [MARKET_DB]: "torn" }, "K");
    openBaseFiles(fake.ports);
    expect(fake.disk).toEqual(new Map(Object.entries(all("K"))));
    expect(fake.reports).toEqual([["market_key_mismatch", 1]]);
  });

  it("rebuilds the device store alone when the key opens another file", () => {
    const fake = fakeDisk({ ...all("K"), [DEVICE_DB]: "torn" }, "K");
    openBaseFiles(fake.ports);
    expect(fake.disk).toEqual(new Map(Object.entries(all("K"))));
    expect(fake.reports).toEqual([["device_key_mismatch", 1]]);
  });

  it("discards everything but a non-demo vault's files when the key opens no file", () => {
    const fake = fakeDisk(all("OLD"), "NEW");
    openBaseFiles(fake.ports);
    // The device store and the cache are new; the demo is gone; the other vault's files stay.
    expect(Object.fromEntries(fake.disk)).toEqual({
      [`vault-${PAIRED}.db`]: "OLD",
      [`log-${PAIRED}.db`]: "OLD",
      [DEVICE_DB]: "NEW",
      [MARKET_DB]: "NEW",
    });
    expect(fake.reports).toEqual([["key_mismatch", 4]]);
  });

  it("discards every file of a demo-only phone when the key opens none", () => {
    expect(
      deviceStoreMismatch(
        [DEVICE_DB, MARKET_DB, `vault-${DEMO}.db`, `log-${DEMO}.db`],
        () => false,
        (v) => v === DEMO,
      ),
    ).toEqual([DEVICE_DB, MARKET_DB, `vault-${DEMO}.db`, `log-${DEMO}.db`]);
  });

  it("closes the device store when the price cache fails otherwise", () => {
    let closed = false;
    expect(() =>
      openBaseFiles({
        ...fakeDisk({}, "K").ports,
        openDevice: () => ({
          close: () => {
            closed = true;
          },
        }),
        openPrices: () => {
          throw new Error("disk_full");
        },
      }),
    ).toThrow("disk_full");
    expect(closed).toBe(true);
  });

  it("rebuilds a demo vault the key does not open", () => {
    const fake = fakeDisk({ [`vault-${DEMO}.db`]: "torn", [`log-${DEMO}.db`]: "K" }, "K");
    const opened = openVaultFiles(
      "demo",
      () => [fake.open(`vault-${DEMO}.db`), fake.open(`log-${DEMO}.db`)],
      () => {
        fake.disk.delete(`vault-${DEMO}.db`);
        fake.disk.delete(`log-${DEMO}.db`);
      },
    );
    expect(opened.kind).toBe("opened");
    expect(fake.disk.get(`vault-${DEMO}.db`)).toBe("K");
  });

  it("leaves a paired vault's files alone and reports needs_repair", () => {
    const fake = fakeDisk({ [`vault-${PAIRED}.db`]: "K", [`log-${PAIRED}.db`]: "torn" }, "K");
    let recreated = false;
    const opened = openVaultFiles(
      "paired",
      () => [fake.open(`vault-${PAIRED}.db`), fake.open(`log-${PAIRED}.db`)],
      () => {
        recreated = true;
      },
    );
    expect(opened).toEqual({ kind: "needs_repair" });
    expect(recreated).toBe(false);
    expect(Object.fromEntries(fake.disk)).toEqual({
      [`vault-${PAIRED}.db`]: "K",
      [`log-${PAIRED}.db`]: "torn",
    });
  });

  it("passes any other failure of a vault open through", () => {
    expect(() =>
      openVaultFiles(
        "paired",
        () => {
          throw new Error("disk_full");
        },
        () => {},
      ),
    ).toThrow("disk_full");
  });
});
