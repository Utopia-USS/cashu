import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crypto } from "@cashu/sync";
import {
  CHUNK_BYTES as CHUNK,
  type Locator,
  MAX_LOCATOR_BYTES as MAX_LOCATOR,
  MAX_MANIFEST_BYTES as MAX_MANIFEST,
  MAX_TOTAL_BYTES,
  type Manifest,
  parseLocator,
  parseManifest,
} from "./format.js";
import { checkedRelative, readPrivate, refPath, unavailable } from "./fs.js";
import { parseJson } from "./json.js";

export function locatorAt(root: string): Locator {
  const value = parseLocator(parseJson(readPrivate(join(root, "locator.json"), MAX_LOCATOR)));
  if (value.manifest.ext !== "manifest") unavailable();
  return value;
}
export function manifestAt(
  root: string,
  locator: Locator,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
): Manifest {
  const plain = crypto.openBlob(
    sodium,
    ring,
    locator.vault,
    locator.manifest,
    readPrivate(refPath(root, locator.manifest), crypto.blobSize(MAX_MANIFEST)),
  );
  try {
    const manifest = parseManifest(parseJson(plain));
    if (
      manifest.format !== 1 ||
      manifest.vault !== locator.vault ||
      manifest.device !== locator.device ||
      manifest.key !== ring.active.kid
    )
      unavailable();
    return manifest;
  } finally {
    plain.fill(0);
  }
}
/** Publication readback yields after each authenticated chunk while the writer queue stays held. */
export async function verifyFilesAsync(
  root: string,
  manifest: Manifest,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
  current: () => boolean,
): Promise<void> {
  const seen = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    checkedRelative(file.path);
    if (seen.has(file.path)) unavailable();
    seen.add(file.path);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) unavailable();
    const hash = createHash("sha256");
    let size = 0;
    for (const ref of file.chunks) {
      if (!current() || ref.ext !== "chk") unavailable();
      const plain = crypto.openBlob(
        sodium,
        ring,
        manifest.vault,
        ref,
        readPrivate(refPath(root, ref), crypto.blobSize(CHUNK)),
      );
      try {
        size += plain.length;
        hash.update(plain);
      } finally {
        plain.fill(0);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!current()) unavailable();
    }
    if (size !== file.size || hash.digest("hex") !== file.sha256) unavailable();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (const required of ["private.db", "view.db", "certificates.v1.json", "recovery-wrap.v1"])
    if (!seen.has(required)) unavailable();
}

export function checkDatabase(path: string, name: "private.db" | "view.db"): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checked = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (checked?.quick_check !== "ok") unavailable();
    if (name === "view.db") {
      const profile = db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number };
      if (profile.n !== 1) unavailable();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
