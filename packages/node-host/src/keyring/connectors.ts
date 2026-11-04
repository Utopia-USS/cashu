import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_ID = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_VALUE_BYTES = 16 * 1024;
const TEST_SERVICE = /^cashu-next-connectors-test\.[a-f0-9]{32}$/;

function unavailable(): never {
  throw new Error("connector_secrets_unavailable");
}
function checkedDataDir(path: string): string {
  try {
    const canonical = realpathSync.native(path);
    const stat = lstatSync(canonical);
    if (
      canonical !== resolve(path) ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      unavailable();
    return canonical;
  } catch {
    return unavailable();
  }
}

export interface ConnectorSecretIdentity {
  readonly profileId: string;
  readonly bindingId: string;
  readonly connectorId: string;
  readonly secretIds: readonly string[];
}
export interface ConnectorSecretAuthority {
  readonly dataDir: string;
  readonly lock: HostLock;
  /** The host checks current profile, binding, connector and owner/holder state here. */
  isCurrent(identity: ConnectorSecretIdentity): boolean;
  /** True only while handling an authenticated owner UI action. */
  isOwnerAction(): boolean;
}
export interface ConnectorSecretVault {
  get(secretId: string): Promise<string | null>;
  set(secretId: string, value: string): Promise<void>;
  clear(secretId: string): Promise<void>;
}

function make(
  authority: ConnectorSecretAuthority,
  identity: ConnectorSecretIdentity,
  service: string,
  keyring: OsKeyringPort,
): ConnectorSecretVault {
  const dataDir = checkedDataDir(authority.dataDir);
  if (
    ![identity.profileId, identity.bindingId, identity.connectorId].every((item) =>
      ID.test(item),
    ) ||
    identity.secretIds.length > 5 ||
    identity.secretIds.some((id) => !SECRET_ID.test(id)) ||
    new Set(identity.secretIds).size !== identity.secretIds.length
  )
    unavailable();
  const pin = { ...identity, secretIds: Object.freeze([...identity.secretIds]) };
  const allowed = new Set(pin.secretIds);
  const check = (owner: boolean): void => {
    if (
      checkedDataDir(authority.dataDir) !== dataDir ||
      !authority.lock.held ||
      authority.lock.path !== hostRunPaths(dataDir).lockPath ||
      !authority.isCurrent(pin) ||
      (owner && !authority.isOwnerAction())
    )
      unavailable();
  };
  const account = (secretId: string): string => {
    if (!SECRET_ID.test(secretId) || !allowed.has(secretId)) unavailable();
    return `binding.${createHash("sha256").update(`${pin.profileId}\0${pin.bindingId}\0${pin.connectorId}\0${secretId}`).digest("hex")}`;
  };
  return {
    async get(secretId) {
      const name = account(secretId);
      check(false);
      let bytes: Uint8Array | null;
      try {
        bytes = await keyring.get(service, name);
      } catch {
        return unavailable();
      }
      try {
        check(false);
        if (!bytes || bytes.length === 0) return null;
        if (bytes.length > MAX_VALUE_BYTES) unavailable();
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
    async set(secretId, value) {
      const name = account(secretId);
      const bytes = new TextEncoder().encode(value);
      if (bytes.length === 0 || bytes.length > MAX_VALUE_BYTES) unavailable();
      try {
        check(true);
        await keyring.set(service, name, bytes);
        check(true);
      } catch {
        return unavailable();
      } finally {
        bytes.fill(0);
      }
    },
    async clear(secretId) {
      const name = account(secretId);
      check(true);
      try {
        await keyring.set(service, name, new Uint8Array());
        check(true);
      } catch {
        return unavailable();
      }
    },
  };
}

/** Separate OS Keyring service; no vault KEK or device identity blobs are reused. */
export function createProductionConnectorSecretVault(
  authority: ConnectorSecretAuthority,
  identity: ConnectorSecretIdentity,
): ConnectorSecretVault {
  const dataDir = checkedDataDir(authority.dataDir);
  const hash = createHash("sha256").update(dataDir, "utf8").digest("hex");
  return make(authority, identity, `cashu-next.connectors.v1.${hash}`, nativeOsKeyring());
}

/** Owner deletion can clear known binding keys even when connector approval is disabled or changed. */
export function createProductionConnectorSecretCleanup(
  authority: ConnectorSecretAuthority,
  identity: ConnectorSecretIdentity,
): Pick<ConnectorSecretVault, "clear"> {
  const vault = createProductionConnectorSecretVault(authority, identity);
  return { clear: (secretId) => vault.clear(secretId) };
}

/** Strict synthetic Keyring only; never touches the real OS service. */
export function createTestConnectorSecretVault(
  authority: ConnectorSecretAuthority,
  identity: ConnectorSecretIdentity,
  service: string,
  keyring: OsKeyringPort,
): ConnectorSecretVault {
  if (
    !TEST_SERVICE.test(service) ||
    !checkedDataDir(authority.dataDir).startsWith(
      `${realpathSync.native(process.env.TMPDIR || "/private/tmp")}/`,
    )
  )
    unavailable();
  return make(authority, identity, service, keyring);
}
