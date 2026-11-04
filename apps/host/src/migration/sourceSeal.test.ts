import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError } from "./contract.js";
import { assertPrivateStagingSeal, assertSameSource, sealPythonSource } from "./sourceSeal.js";

const roots: string[] = [];
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-migration-seal-")));
  roots.push(root);
  writeFileSync(join(root, "cashu.db"), "synthetic-db", { mode: 0o600 });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source byte seal", () => {
  it("seals DB, WAL, SHM and nested side files without changing source bytes", () => {
    const root = fixture();
    writeFileSync(join(root, "cashu.db-wal"), "synthetic-wal", { mode: 0o600 });
    writeFileSync(join(root, "cashu.db-shm"), "synthetic-shm", { mode: 0o600 });
    mkdirSync(join(root, "profiles"), { mode: 0o700 });
    mkdirSync(join(root, "profiles", "sample"), { mode: 0o700 });
    writeFileSync(join(root, "profiles", "sample", "budget.json"), "{}", { mode: 0o600 });
    const first = sealPythonSource(root);
    expect(first.entries.map((e) => e.path)).toEqual([
      "cashu.db",
      "cashu.db-shm",
      "cashu.db-wal",
      "profiles/sample/budget.json",
    ]);
    assertSameSource(first, sealPythonSource(root));
    writeFileSync(join(root, "cashu.db-wal"), "changed-wal", { mode: 0o600 });
    expect(() => assertSameSource(first, sealPythonSource(root))).toThrowError(
      new MigrationError("source_changed"),
    );
  });

  it("refuses linked side files and hard-linked database files", () => {
    const root = fixture();
    mkdirSync(join(root, "imports"), { mode: 0o700 });
    symlinkSync(join(root, "cashu.db"), join(root, "imports", "linked"));
    expect(() => sealPythonSource(root)).toThrowError(new MigrationError("source_unsafe"));
    rmSync(join(root, "imports", "linked"));
    linkSync(join(root, "cashu.db"), join(root, "imports", "linked"));
    expect(() => sealPythonSource(root)).toThrowError(new MigrationError("source_unsafe"));
  });

  it("refuses an unclassified root-level entry", () => {
    const root = fixture();
    mkdirSync(join(root, "worker-old"), { mode: 0o700 });
    expect(() => sealPythonSource(root)).toThrowError(new MigrationError("semantic_difference"));
    rmSync(join(root, "worker-old"), { recursive: true });
    writeFileSync(join(root, "notes.txt"), "synthetic", { mode: 0o600 });
    expect(() => sealPythonSource(root)).toThrowError(new MigrationError("semantic_difference"));
  });

  it("classifies every other top-level entry the Python app writes and seals none of it", () => {
    const root = fixture();
    const dir = (path: string) => mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
    const file = (path: string, text: string) =>
      writeFileSync(join(root, path), text, { mode: 0o600 });
    dir("worker");
    file("worker/state.json", "{}");
    file("worker/ownership.json", "{}");
    dir("mcp");
    file("mcp/payee.key", "synthetic-key");
    file("legacy-migration.json", "{}");
    file("MIGRATED_FROM.txt", "synthetic note\n");
    file(".env", "CASHU_CATEGORIZE_BACKEND=ollama\n");
    for (const name of [
      "api-token",
      "app-location.json",
      "desktop.json",
      "settings.json",
      "rename-migration.json",
    ]) {
      file(name, "{}");
      file(`${name}.tmp`, "{}");
    }
    for (const side of ["", "-wal", "-shm", "-journal"])
      file(`cashu.db.migrating${side}`, "synthetic-copy");
    dir("locks");
    dir("tmp/connectors");
    dir("backups");
    file(".DS_Store", "synthetic");
    dir("market");
    file("market/calendar.tmp", "{}");
    expect(sealPythonSource(root).entries.map((e) => e.path)).toEqual(["cashu.db"]);
  });

  it("omits approved process and bank-consent files from the financial copy", () => {
    const root = fixture();
    mkdirSync(join(root, "logs"), { mode: 0o700 });
    writeFileSync(join(root, "api-token"), "synthetic-token", { mode: 0o600 });
    writeFileSync(join(root, "eb_sessions.json"), "{}", { mode: 0o600 });
    writeFileSync(join(root, "enablebanking_private.pem"), "synthetic-key", { mode: 0o600 });
    writeFileSync(join(root, "settings.json"), '{"lang":"pl"}', { mode: 0o600 });
    writeFileSync(join(root, "rename-migration.json"), "{}", { mode: 0o600 });
    mkdirSync(join(root, "connectors"), { mode: 0o700 });
    writeFileSync(join(root, "connectors", "connector.py"), "# synthetic\n", { mode: 0o600 });
    expect(sealPythonSource(root).entries.map((e) => e.path)).toEqual(["cashu.db"]);
  });

  it("seals only the known market calendar cache and refuses extra market files", () => {
    const root = fixture();
    mkdirSync(join(root, "market"), { mode: 0o700 });
    writeFileSync(join(root, "market", "calendar.json"), '{"macro":[]}', { mode: 0o600 });
    const sealed = sealPythonSource(root);
    expect(sealed.entries.map((entry) => entry.path)).toEqual(["cashu.db", "market/calendar.json"]);
    writeFileSync(join(root, "market", "other.json"), "{}", { mode: 0o600 });
    expect(() => sealPythonSource(root)).toThrowError(new MigrationError("semantic_difference"));
  });

  it("reads older owner-owned 0644/0755 source files but refuses them as new staging", () => {
    const root = fixture();
    mkdirSync(join(root, "profiles"), { mode: 0o755 });
    chmodSync(join(root, "cashu.db"), 0o644);
    const source = sealPythonSource(root);
    expect(source.entries).toHaveLength(1);
    expect(() => assertPrivateStagingSeal(source)).toThrowError(
      new MigrationError("snapshot_unverified"),
    );
  });
});
