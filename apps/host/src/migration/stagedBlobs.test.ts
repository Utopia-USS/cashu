import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { StrictConversion } from "./convert.js";
import { sealPythonSource } from "./sourceSeal.js";
import { collectStagedProposalBlobs } from "./stagedBlobs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  conversion: StrictConversion;
  path: string;
  bytes: Uint8Array;
  archive: Uint8Array;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-staged-blob-")));
  roots.push(root);
  const bytes = new TextEncoder().encode("synthetic import bytes\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, "imports", "alpha", ".proposals");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relative = `imports/alpha/.proposals/${digest}-0123456789ab.csv`;
  const path = join(root, relative);
  writeFileSync(path, bytes, { mode: 0o600 });
  const archive = new TextEncoder().encode("synthetic archive bytes\n");
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  writeFileSync(join(root, "imports", "alpha", `${archiveDigest}.CSV`), archive, { mode: 0o600 });
  const db = new DatabaseSync(join(root, "cashu.db"));
  try {
    db.exec("CREATE TABLE proposals(id INTEGER PRIMARY KEY,profile_id INTEGER,payload TEXT)");
    db.exec(
      "CREATE TABLE inv_import_batches(id INTEGER PRIMARY KEY,profile_id INTEGER,archive_path TEXT,file_sha256 TEXT)",
    );
    db.prepare("INSERT INTO proposals VALUES (?,?,?)").run(
      1,
      1,
      JSON.stringify({ account_id: 2, staged: relative }),
    );
    db.prepare("INSERT INTO inv_import_batches VALUES (?,?,?,?)").run(
      1,
      1,
      `imports/alpha/${archiveDigest}.CSV`,
      archiveDigest,
    );
  } finally {
    db.close();
  }
  chmodSync(join(root, "cashu.db"), 0o600);
  const conversion = {
    snapshot: sealPythonSource(root),
    genesis: { vaults: [{ profileId: 1, slug: "alpha", vault: "a".repeat(32) }] },
  } as unknown as StrictConversion;
  return { conversion, path, bytes, archive };
}

it("collects exact staged and archived bytes for their mapped fresh vault", () => {
  const { conversion, bytes, archive } = fixture();
  const blobs = collectStagedProposalBlobs(conversion);
  expect(blobs).toHaveLength(2);
  expect(blobs[0]?.vaultId).toBe("a".repeat(32));
  expect(blobs[0]?.blob).toEqual({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ext: "csv",
  });
  expect(blobs[0]?.bytes).toEqual(bytes);
  expect(blobs[1]?.blob).toEqual({
    sha256: createHash("sha256").update(archive).digest("hex"),
    ext: "csv",
  });
  expect(blobs[1]?.bytes).toEqual(archive);
});

it("refuses source drift before returning staged bytes", () => {
  const { conversion, path } = fixture();
  writeFileSync(path, "changed", { mode: 0o600 });
  expect(() => collectStagedProposalBlobs(conversion)).toThrow();
});

it("refuses a proposal referring to another profile's sealed file", () => {
  const { conversion, path, bytes } = fixture();
  const source = conversion.snapshot.root;
  const other = join(source, "imports", "beta", ".proposals");
  mkdirSync(other, { recursive: true, mode: 0o700 });
  const foreign = join(other, path.split("/").at(-1) ?? "missing.csv");
  writeFileSync(foreign, bytes, { mode: 0o600 });
  const db = new DatabaseSync(join(source, "cashu.db"));
  try {
    db.prepare("UPDATE proposals SET payload=? WHERE id=1").run(
      JSON.stringify({ staged: `imports/beta/.proposals/${path.split("/").at(-1)}` }),
    );
  } finally {
    db.close();
  }
  const resealed = { ...conversion, snapshot: sealPythonSource(source) };
  expect(() => collectStagedProposalBlobs(resealed)).toThrow();
});
