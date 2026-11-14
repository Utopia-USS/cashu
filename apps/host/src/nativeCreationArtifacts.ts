import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { crypto } from "@cashu/sync";

const ID = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const MAX_WRAP_FILE = 32 * 1024;

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("native_recovery_wrap_invalid");
}

/** A fixed, private artifact. The bytes still need root-signature verification before recovery. */
export function readNativeRecoveryWrap(dataDir: string, vaultId: string): Uint8Array {
  if (!ID.test(vaultId) || resolve(dataDir) !== dataDir)
    throw new Error("native_recovery_wrap_invalid");
  privateDirectory(dataDir);
  privateDirectory(join(dataDir, "vaults"));
  const root = join(dataDir, "vaults", vaultId);
  privateDirectory(root);
  const path = join(root, "recovery-wrap.v1");
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid()) ||
    before.size > MAX_WRAP_FILE
  )
    throw new Error("native_recovery_wrap_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    )
      throw new Error("native_recovery_wrap_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) throw new Error("native_recovery_wrap_invalid");
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("native_recovery_wrap_invalid");
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join("\0") !== ["format", "vaultId", "wrap"].sort().join("\0")
    )
      throw new Error("native_recovery_wrap_invalid");
    const artifact = raw as { format: unknown; vaultId: unknown; wrap: unknown };
    if (
      artifact.format !== 1 ||
      artifact.vaultId !== vaultId ||
      typeof artifact.wrap !== "string" ||
      !B64.test(artifact.wrap)
    )
      throw new Error("native_recovery_wrap_invalid");
    const wrap = Buffer.from(artifact.wrap, "base64url");
    if (
      wrap.length < 100 ||
      wrap.length > MAX_WRAP_FILE ||
      wrap[0] !== crypto.WRAP_VERSION ||
      wrap.toString("base64url") !== artifact.wrap
    )
      throw new Error("native_recovery_wrap_invalid");
    return Uint8Array.from(wrap);
  } finally {
    closeSync(fd);
  }
}
