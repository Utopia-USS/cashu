import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { crypto } from "@cashu/sync";
import {
  type NativeVaultInventoryEntry,
  validateNativeVaultInventorySet,
} from "./sync/keys/deviceAuthority.js";

const ID = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const MAX_INVENTORY = 64 * 1024;
const MAX_CERTIFICATES = 64;
const MAX_CERT_FILE = 32 * 1024;

export const NATIVE_INVENTORY = "native/v1/inventory.json";
export const NATIVE_CERTIFICATES = "certificates.v1.json";

export interface ExistingNativeInventory {
  readonly entries: readonly NativeVaultInventoryEntry[];
  readonly certificates: ReadonlyMap<string, readonly Uint8Array[]>;
  readonly fingerprint: string;
}

function refuse(code: string): never {
  throw new Error(code);
}

function fields(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function privateStat(path: string, kind: "file" | "directory"): Stats {
  try {
    const stat = lstatSync(path);
    if (!stat) refuse("native_inventory_invalid");
    if (
      stat.isSymbolicLink() ||
      (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
      stat.mode % 0o1000 !== (kind === "file" ? 0o600 : 0o700) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      realpathSync(path) !== path
    )
      refuse("native_inventory_invalid");
    return stat;
  } catch {
    refuse("native_inventory_invalid");
  }
}

function readPrivate(path: string, max: number): Buffer {
  const before = privateStat(path, "file");
  if (before.size > max) refuse("native_inventory_invalid");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    refuse("native_inventory_invalid");
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.mode % 0o1000 !== 0o600 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size > max
    )
      refuse("native_inventory_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) refuse("native_inventory_invalid");
    return bytes;
  } catch {
    refuse("native_inventory_invalid");
  } finally {
    closeSync(fd);
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("native_inventory_invalid");
  }
}

function parseCertificates(bytes: Buffer, vaultId: string, deviceId: string): Uint8Array[] {
  const parsed = parseJson(bytes);
  if (
    !fields(parsed, ["format", "vaultId", "deviceId", "certificates"]) ||
    parsed.format !== 1 ||
    parsed.vaultId !== vaultId ||
    parsed.deviceId !== deviceId ||
    !Array.isArray(parsed.certificates) ||
    parsed.certificates.length < 1 ||
    parsed.certificates.length > MAX_CERTIFICATES
  )
    refuse("native_inventory_invalid");
  const seen = new Set<string>();
  return parsed.certificates.map((encoded) => {
    if (typeof encoded !== "string" || !B64.test(encoded)) refuse("native_inventory_invalid");
    const cert = Buffer.from(encoded, "base64url");
    if (
      cert.length !== crypto.CERT_BYTES ||
      cert[0] !== 1 ||
      cert.toString("base64url") !== encoded ||
      seen.has(encoded)
    )
      refuse("native_inventory_invalid");
    seen.add(encoded);
    return Uint8Array.from(cert);
  });
}

/** Read-only candidate discovery. It gives no device or vault authority. */
export function readExistingNativeInventory(dataDir: string): ExistingNativeInventory {
  if (resolve(dataDir) !== dataDir) refuse("native_inventory_invalid");
  try {
    if (realpathSync(dataDir) !== dataDir) refuse("native_inventory_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse("native_setup_required");
    refuse("native_inventory_invalid");
  }
  privateStat(dataDir, "directory");
  const nativeDir = join(dataDir, "native");
  const versionDir = join(nativeDir, "v1");
  try {
    lstatSync(nativeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse("native_setup_required");
    refuse("native_inventory_invalid");
  }
  privateStat(nativeDir, "directory");
  privateStat(versionDir, "directory");
  const inventoryBytes = readPrivate(join(versionDir, "inventory.json"), MAX_INVENTORY);
  const parsed = parseJson(inventoryBytes);
  if (!fields(parsed, ["format", "vaults"]) || parsed.format !== 1 || !Array.isArray(parsed.vaults))
    refuse("native_inventory_invalid");
  if (parsed.vaults.length === 0) refuse("native_setup_required");
  if (parsed.vaults.length > 64) refuse("native_inventory_invalid");
  const vaultsDir = join(dataDir, "vaults");
  privateStat(vaultsDir, "directory");
  const entries: NativeVaultInventoryEntry[] = [];
  const certificates = new Map<string, readonly Uint8Array[]>();
  const seenDevices = new Set<string>();
  const digestParts: Buffer[] = [inventoryBytes];
  for (const raw of parsed.vaults) {
    if (
      !fields(raw, ["vaultId", "deviceId", "state", "enrollment"]) ||
      typeof raw.vaultId !== "string" ||
      !ID.test(raw.vaultId) ||
      typeof raw.deviceId !== "string" ||
      !ID.test(raw.deviceId) ||
      (raw.enrollment !== "creator" &&
        raw.enrollment !== "pairing" &&
        raw.enrollment !== "recovery")
    )
      refuse("native_inventory_invalid");
    if (raw.state !== "ready") {
      if (raw.state === "provisioning" || raw.state === "pairing" || raw.state === "recovery")
        refuse("native_provisioning_pending");
      refuse("native_inventory_invalid");
    }
    if (certificates.has(raw.vaultId) || seenDevices.has(raw.deviceId))
      refuse("native_inventory_invalid");
    seenDevices.add(raw.deviceId);
    const vaultRoot = join(vaultsDir, raw.vaultId);
    privateStat(vaultRoot, "directory");
    const certBytes = readPrivate(join(vaultRoot, NATIVE_CERTIFICATES), MAX_CERT_FILE);
    const certs = parseCertificates(certBytes, raw.vaultId, raw.deviceId);
    digestParts.push(certBytes);
    certificates.set(raw.vaultId, certs);
    entries.push(
      Object.freeze({
        vaultId: raw.vaultId,
        deviceId: raw.deviceId,
        vaultRoot,
        state: "ready",
        enrollment: raw.enrollment,
      }),
    );
  }
  validateNativeVaultInventorySet(entries, dataDir);
  return {
    entries: Object.freeze(entries),
    certificates,
    fingerprint: hashParts(digestParts),
  };
}

function hashParts(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}
