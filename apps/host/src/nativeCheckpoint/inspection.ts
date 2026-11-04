import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crypto } from "@cashu/sync";
import {
  CHUNK_BYTES as CHUNK,
  type FileEntry,
  type Locator,
  MAX_LOCATOR_BYTES as MAX_LOCATOR,
  MAX_MANIFEST_BYTES as MAX_MANIFEST,
  MAX_TOTAL_BYTES,
  type Manifest,
  parseLocator,
  parseManifest,
  SHA,
} from "./format.js";
import { checkedRelative, privateDir, readPrivate, refPath, unavailable } from "./fs.js";
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
export function verifyFiles(
  root: string,
  manifest: Manifest,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
): void {
  const seen = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    checkedRelative(file.path);
    if (
      seen.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !SHA.test(file.sha256) ||
      !Array.isArray(file.chunks)
    )
      unavailable();
    seen.add(file.path);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) unavailable();
    const hash = createHash("sha256");
    let size = 0;
    for (const ref of file.chunks) {
      if (!ref || !SHA.test(ref.sha256) || ref.ext !== "chk") unavailable();
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
    }
    if (size !== file.size || hash.digest("hex") !== file.sha256) unavailable();
  }
  for (const required of ["private.db", "view.db", "certificates.v1.json", "recovery-wrap.v1"])
    if (!seen.has(required)) unavailable();
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

function extractFile(
  root: string,
  file: FileEntry,
  destination: string,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
  vault: string,
): void {
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDir(directory);
  const fd = openSync(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let size = 0;
    for (const ref of file.chunks) {
      const plain = crypto.openBlob(
        sodium,
        ring,
        vault,
        ref,
        readPrivate(refPath(root, ref), crypto.blobSize(CHUNK)),
      );
      try {
        let at = 0;
        while (at < plain.length) {
          const n = writeSync(fd, plain, at, plain.length - at);
          if (n <= 0) unavailable();
          at += n;
        }
        size += plain.length;
      } finally {
        plain.fill(0);
      }
    }
    if (size !== file.size) unavailable();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

/** Must be called from the live native vault queue immediately before a destructive command. */
function openArchive(
  path: string,
  phrase: string,
  sodium: crypto.Sodium,
): {
  readonly locator: Locator;
  readonly manifest: Manifest;
  readonly ring: crypto.Keyring;
} {
  privateDir(path);
  privateDir(join(path, "chunks"));
  const locator = locatorAt(path);
  const recovery = crypto.recoveryIdentity(sodium, phrase);
  let ring: crypto.Keyring | undefined;
  try {
    const base = Buffer.from(locator.baseWrap, "base64url");
    const seed = crypto.unwrapKeys(
      sodium,
      base,
      recovery,
      { vaultId: locator.vault, recoveryPublicKey: recovery.publicKeys },
      (id) => (id === crypto.RECOVERY_SIGNER_ID ? recovery.signPublicKey : undefined),
      { acceptEpoch: () => true },
    );
    ring = seed.ring;
    const certificates = locator.certificates.map((c) => Buffer.from(c, "base64url"));
    const trusted = crypto.verifyCertificates(
      sodium,
      locator.vault,
      recovery.signPublicKey,
      certificates,
      new Set(),
    );
    const signer = trusted.devices.get(locator.device);
    if (!signer) unavailable();
    for (const encoded of locator.currentWraps)
      crypto.unwrapKeys(
        sodium,
        Buffer.from(encoded, "base64url"),
        recovery,
        ring,
        (id) => (id === locator.device ? signer.signPublicKey : undefined),
        { acceptEpoch: () => true },
      );
    const manifest = manifestAt(path, locator, sodium, ring);
    verifyFiles(path, manifest, sodium, ring);
    return { locator, manifest, ring };
  } catch (error) {
    ring?.wipe();
    throw error;
  } finally {
    recovery.wipe();
  }
}

/** Independently verifies an archive and opens both backed-up DBs read-only, then removes scratch. */
export function inspectNativeCheckpoint(
  path: string,
  phrase: string,
  sodium: crypto.Sodium,
): {
  readonly vault: string;
  readonly device: string;
  readonly frontier: string;
  readonly files: number;
} {
  const { locator, manifest, ring } = openArchive(path, phrase, sodium);
  try {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cashu-checkpoint-inspect-")));
    try {
      privateDir(scratch);
      for (const name of ["private.db", "view.db"]) {
        const file = manifest.files.find((candidate) => candidate.path === name);
        if (!file) unavailable();
        const destination = join(scratch, name);
        extractFile(path, file, destination, sodium, ring, locator.vault);
        checkDatabase(destination, name as "private.db" | "view.db").close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return {
      vault: locator.vault,
      device: locator.device,
      frontier: manifest.frontier,
      files: manifest.files.length,
    };
  } finally {
    ring.wipe();
  }
}

/** Recover every archived file into a new isolated private root for offline inspection only. */
export async function withIsolatedNativeCheckpoint<T>(
  path: string,
  phrase: string,
  sodium: crypto.Sodium,
  inspect: (snapshot: {
    readonly root: string;
    readonly vault: string;
    readonly device: string;
    readonly frontier: string;
    readonly privateDb: DatabaseSync;
    readonly viewDb: DatabaseSync;
  }) => T | Promise<T>,
): Promise<T> {
  const { locator, manifest, ring } = openArchive(path, phrase, sodium);
  let scratch: string | undefined;
  let privateDb: DatabaseSync | undefined;
  let viewDb: DatabaseSync | undefined;
  let result!: T;
  let failure: unknown;
  let failed = false;
  try {
    scratch = mkdtempSync(join(tmpdir(), "cashu-checkpoint-inspect-"));
    scratch = realpathSync(scratch);
    privateDir(scratch);
    for (const file of manifest.files) {
      checkedRelative(file.path);
      extractFile(path, file, join(scratch, ...file.path.split("/")), sodium, ring, locator.vault);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    privateDb = checkDatabase(join(scratch, "private.db"), "private.db");
    viewDb = checkDatabase(join(scratch, "view.db"), "view.db");
    result = await inspect({
      root: scratch,
      vault: locator.vault,
      device: locator.device,
      frontier: manifest.frontier,
      privateDb,
      viewDb,
    });
  } catch (error) {
    failure = error;
    failed = true;
  }
  const cleanup = (work: () => void) => {
    try {
      work();
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }
  };
  cleanup(() => viewDb?.close());
  cleanup(() => privateDb?.close());
  if (scratch !== undefined) cleanup(() => rmSync(scratch, { recursive: true, force: true }));
  cleanup(() => ring.wipe());
  if (failed) throw failure;
  return result;
}
