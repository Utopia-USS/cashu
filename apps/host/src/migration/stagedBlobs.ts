import { createHash } from "node:crypto";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { MigrationError } from "./contract.js";
import { filesOf, type StrictConversion } from "./convert.js";
import { assertPrivateStagingSeal, assertSameSource, sealPythonSource } from "./sourceSeal.js";

const STAGED_NAME = /^([0-9a-f]{64})(?:-[0-9A-Za-z]+)?\.([A-Za-z0-9]{1,10})$/;
const ARCHIVE_NAME = /^([0-9a-f]{64})\.([A-Za-z0-9]{1,10})$/;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface StagedProposalBlob {
  readonly vaultId: string;
  readonly blob: { readonly sha256: string; readonly ext: string };
  /** Private in-memory bytes only, never a journal or status payload. */
  readonly bytes: Uint8Array;
}

/** Independently recover every referenced staged or archive blob from the private source copy. */
export function collectStagedProposalBlobs(
  conversion: StrictConversion,
): readonly StagedProposalBlob[] {
  try {
    assertPrivateStagingSeal(conversion.snapshot);
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
    const vaults = new Map(
      conversion.genesis.vaults.map((vault) => [
        vault.profileId,
        { id: vault.vault, slug: vault.slug },
      ]),
    );
    const entries = new Map(conversion.snapshot.entries.map((entry) => [entry.path, entry]));
    const files = filesOf(conversion.snapshot.root, conversion.snapshot);
    const db = openNodeSqlite(join(conversion.snapshot.root, "cashu.db"), { readOnly: true });
    const output: StagedProposalBlob[] = [];
    const seen = new Map<string, Uint8Array>();
    let totalBytes = 0;
    const collect = (
      vaultId: string,
      slug: string,
      relative: string,
      pattern: RegExp,
      expected?: string,
    ) => {
      if (relative.startsWith("/") || relative.includes("\\")) {
        throw new MigrationError("semantic_difference");
      }
      const parts = relative.split("/");
      if (parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new MigrationError("semantic_difference");
      }
      const staged = pattern === STAGED_NAME;
      if (
        parts.length !== (staged ? 4 : 3) ||
        parts[0] !== "imports" ||
        parts[1] !== slug ||
        (staged && parts[2] !== ".proposals")
      ) {
        throw new MigrationError("semantic_difference");
      }
      const match = pattern.exec(parts.at(-1) ?? "");
      const entry = entries.get(relative);
      if (!match || !entry || entry.bytes > MAX_FILE_BYTES) {
        throw new MigrationError("semantic_difference");
      }
      const bytes = files.read(relative);
      if (!bytes || bytes.length !== entry.bytes) throw new MigrationError("source_changed");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== match[1] || (expected !== undefined && sha256 !== expected)) {
        throw new MigrationError("semantic_difference");
      }
      const ext = (match[2] ?? "").toLowerCase();
      const key = `${vaultId}\0${sha256}.${ext}`;
      const prior = seen.get(key);
      if (prior) {
        if (Buffer.compare(prior, bytes) !== 0) throw new MigrationError("semantic_difference");
        return;
      }
      totalBytes += entry.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new MigrationError("semantic_difference");
      const owned = Uint8Array.from(bytes);
      seen.set(key, owned);
      output.push({ vaultId, blob: { sha256, ext }, bytes: owned });
    };
    try {
      const proposals = db
        .prepare("SELECT profile_id AS profileId,payload FROM proposals ORDER BY id")
        .all<{ profileId: number; payload: string }>();
      for (const row of proposals) {
        const vault = vaults.get(row.profileId);
        if (!vault) throw new MigrationError("mapping_invalid");
        const payload: unknown = JSON.parse(row.payload);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new MigrationError("semantic_difference");
        }
        if (!("staged" in payload)) continue;
        const staged = (payload as { staged: unknown }).staged;
        if (staged === null) continue;
        if (typeof staged !== "string") {
          throw new MigrationError("semantic_difference");
        }
        collect(vault.id, vault.slug, staged, STAGED_NAME);
      }
      const archives = db
        .prepare(
          "SELECT profile_id AS profileId,archive_path AS archivePath,file_sha256 AS fileSha256 FROM inv_import_batches WHERE archive_path IS NOT NULL ORDER BY id",
        )
        .all<{ profileId: number; archivePath: string; fileSha256: string }>();
      for (const row of archives) {
        const vault = vaults.get(row.profileId);
        if (!vault || typeof row.archivePath !== "string" || typeof row.fileSha256 !== "string") {
          throw new MigrationError("mapping_invalid");
        }
        collect(vault.id, vault.slug, row.archivePath, ARCHIVE_NAME, row.fileSha256);
      }
    } finally {
      db.close();
    }
    assertSameSource(conversion.snapshot, sealPythonSource(conversion.snapshot.root));
    return output;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("semantic_difference");
  }
}
