// The keyed open's statement order over a fake connection (expo-sqlite and SQLCipher exist only on the
// device): the key is the first statement, the cipher's presence is checked, plain SQLite throws, one
// probe read proves the key, a NOTADB answer is a key mismatch, and the boot's recovery discards the
// files and opens once more.
import { isDbKeyMismatch, keyDatabase, openWithKeyRecovery } from "./sqliteKeying";

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
