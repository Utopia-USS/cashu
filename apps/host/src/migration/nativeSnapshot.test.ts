import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { captureOfflineSnapshot } from "./snapshot.js";
import {
  assertPrivateStagingSeal,
  type PythonDatabaseName,
  sealPythonSource,
} from "./sourceSeal.js";

const roots: string[] = [];
function privateRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-snapshot-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline native WAL snapshot", () => {
  it("copies an older readable 0644/0755 source into strict private staging", async () => {
    const source = privateRoot();
    const target = join(privateRoot(), "snapshot");
    const writer = new DatabaseSync(join(source, "cashu.db"));
    writer.exec("CREATE TABLE synthetic (n INTEGER NOT NULL); INSERT INTO synthetic VALUES (3)");
    writer.close();
    chmodSync(source, 0o755);
    chmodSync(join(source, "cashu.db"), 0o644);
    const before = sealPythonSource(source);
    const result = await captureOfflineSnapshot(source, target);
    assertPrivateStagingSeal(result.snapshot);
    expect(sealPythonSource(source).digest).toBe(before.digest);
  });

  it.each(["cashu.db", "finanse.db"] as const)(
    "backs up an uncheckpointed %s without source writes",
    async (database: PythonDatabaseName) => {
      const source = privateRoot();
      const target = join(privateRoot(), "snapshot");
      const writer = new DatabaseSync(join(source, database));
      try {
        writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
        writer.exec(
          "CREATE TABLE synthetic (n INTEGER NOT NULL); INSERT INTO synthetic VALUES (7)",
        );
        for (const suffix of ["", "-wal", "-shm"]) {
          const path = join(source, `${database}${suffix}`);
          if (lstatSync(path, { throwIfNoEntry: false })) chmodSync(path, 0o600);
        }
        const before = sealPythonSource(source, database);
        expect(before.entries.some((entry) => entry.path === `${database}-wal`)).toBe(true);
        const captured = await captureOfflineSnapshot(source, target, database);
        expect(captured.source.digest).toBe(before.digest);
        expect(sealPythonSource(source, database).digest).toBe(before.digest);
        const folded = new DatabaseSync(join(target, "cashu.db"), { readOnly: true });
        try {
          expect(folded.prepare("SELECT n FROM synthetic").get()).toEqual({ n: 7 });
        } finally {
          folded.close();
        }
      } finally {
        writer.close();
      }
    },
  );
});
