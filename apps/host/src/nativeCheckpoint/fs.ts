import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { crypto } from "@cashu/sync";
import {
  CHUNK_BYTES as CHUNK,
  type FileEntry,
  MAX_DEPTH,
  MAX_FILES,
  MAX_MANIFEST_BYTES,
  MAX_TOTAL_BYTES,
  type Ref,
  SHA,
} from "./format.js";

export function unavailable(): never {
  throw new Error("native_checkpoint_unavailable");
}
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function privateDir(path: string): void {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && s.uid !== process.getuid()) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    unavailable();
}
export interface DirectoryPin {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
export function pinDirectory(path: string): DirectoryPin {
  privateDir(path);
  const stat = lstatSync(path);
  return { path, dev: stat.dev, ino: stat.ino };
}
export function assertPins(pins: readonly DirectoryPin[]): void {
  for (const pin of pins) {
    privateDir(pin.path);
    const stat = lstatSync(pin.path);
    if (stat.dev !== pin.dev || stat.ino !== pin.ino) unavailable();
  }
}
export function createPrivateDir(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  privateDir(path);
  syncDirectory(resolve(path, ".."));
}
export function writePrivate(path: string, bytes: Uint8Array): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let at = 0;
    while (at < bytes.length) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (n <= 0) unavailable();
      at += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function readPrivate(path: string, max: number): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    const named = lstatSync(path);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.dev !== named.dev ||
      s.ino !== named.ino ||
      s.size !== named.size ||
      s.size < 0 ||
      s.size > max ||
      (s.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && s.uid !== process.getuid())
    )
      unavailable();
    const out = new Uint8Array(s.size);
    let at = 0;
    while (at < out.length) {
      const n = readSync(fd, out, at, out.length - at, at);
      if (n <= 0) unavailable();
      at += n;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== s.dev ||
      after.ino !== s.ino ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs
    )
      unavailable();
    return out;
  } finally {
    closeSync(fd);
  }
}
export function checkedRelative(path: string): void {
  if (
    !path ||
    Buffer.byteLength(path, "utf8") > 1024 ||
    path.startsWith("/") ||
    path.split("/").length > MAX_DEPTH + 1 ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    unavailable();
}
export function estimatedManifestBytes(path: string, size: number): number {
  checkedRelative(path);
  return 256 + Buffer.byteLength(path, "utf8") + 120 * Math.ceil(size / CHUNK);
}
export function listPrivateFiles(
  root: string,
  relativeDir: string,
  budget: {
    files: number;
    bytes: number;
    manifestBytes: number;
    directories: number;
    pins: DirectoryPin[];
  },
  depth = 1,
): string[] {
  if (depth > MAX_DEPTH) unavailable();
  const dir = join(root, relativeDir);
  budget.pins.push(pinDirectory(dir));
  budget.directories++;
  if (budget.directories > MAX_FILES) unavailable();
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) unavailable();
    const relativePath = `${relativeDir}/${name}`;
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) result.push(...listPrivateFiles(root, relativePath, budget, depth + 1));
    else if (stat.isFile()) {
      if (
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        unavailable();
      budget.files++;
      budget.bytes += stat.size;
      budget.manifestBytes += estimatedManifestBytes(relativePath, stat.size);
      if (
        budget.files > MAX_FILES ||
        !Number.isSafeInteger(budget.bytes) ||
        budget.bytes > MAX_TOTAL_BYTES ||
        budget.manifestBytes > MAX_MANIFEST_BYTES
      )
        unavailable();
      result.push(relativePath);
    } else unavailable();
  }
  return result;
}
export function existingDir(path: string): boolean {
  try {
    privateDir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Remove only this feature's incomplete private publications, including crash-left DB scratch. */
export function scrubIncompleteNativeCheckpoints(root: string): void {
  privateDir(root);
  const parent = join(root, "checkpoints");
  if (!existingDir(parent)) return;
  for (const name of readdirSync(parent)) {
    if (!/^\.[0-9a-f]{8}-[0-9a-f-]{27}\.partial$/.test(name)) continue;
    const path = join(parent, name);
    privateDir(path);
    rmSync(path, { recursive: true });
  }
  syncDirectory(parent);
}
export function refPath(root: string, ref: Ref): string {
  if (!SHA.test(ref.sha256) || (ref.ext !== "chk" && ref.ext !== "manifest")) unavailable();
  return join(root, "chunks", `${ref.sha256}.${ref.ext}.enc`);
}
export function sealChunk(
  root: string,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
  vault: string,
  bytes: Uint8Array,
  ext: Ref["ext"],
): Ref {
  if (bytes.length === 0 || bytes.length > crypto.MAX_BLOB_PLAINTEXT) unavailable();
  const ref = { sha256: sha(bytes), ext } as const;
  const path = refPath(root, ref);
  const sealed = crypto.sealBlob(sodium, ring, vault, ref, bytes);
  try {
    writePrivate(path, sealed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = crypto.openBlob(
      sodium,
      ring,
      vault,
      ref,
      readPrivate(path, crypto.blobSize(crypto.MAX_BLOB_PLAINTEXT)),
    );
    try {
      if (sha(existing) !== ref.sha256) unavailable();
    } finally {
      existing.fill(0);
    }
  }
  return ref;
}
export async function captureFile(
  source: string,
  targetRoot: string,
  relativePath: string,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
  vault: string,
  stillCurrent: (sourcePath: string) => boolean,
): Promise<FileEntry> {
  checkedRelative(relativePath);
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    const named = lstatSync(source);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== named.size ||
      !Number.isSafeInteger(before.size) ||
      before.size > MAX_TOTAL_BYTES ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    )
      unavailable();
    const hash = createHash("sha256");
    const chunks: Ref[] = [];
    let at = 0;
    while (at < before.size) {
      if (!stillCurrent(source)) unavailable();
      const bytes = new Uint8Array(Math.min(CHUNK, before.size - at));
      let filled = 0;
      try {
        while (filled < bytes.length) {
          const n = readSync(fd, bytes, filled, bytes.length - filled, at + filled);
          if (n <= 0) unavailable();
          filled += n;
        }
        hash.update(bytes);
        chunks.push(sealChunk(targetRoot, sodium, ring, vault, bytes, "chk"));
      } finally {
        bytes.fill(0);
      }
      at += filled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!stillCurrent(source)) unavailable();
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      unavailable();
    return { path: relativePath, size: before.size, sha256: hash.digest("hex"), chunks };
  } finally {
    closeSync(fd);
  }
}
