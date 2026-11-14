// The sync relay identity of one data dir (M4): the anonymous Firebase uid and its refresh token, one
// record per data dir (every vault of this Mac shares it), in its own OS keyring service
// `<prefix>.relay-auth.v1.<sha256(data dir)>`. The refresh token is a secret: it never leaves this
// boundary except to the relay's own token endpoint; errors are one fixed code.
//
// Beside it, in the same service, one relay recovery secret per vault (account `recovery.<vaultId>`):
// 32 random bytes this Mac created when it enabled the vault's sync, whose sha256 the vault document at
// the relay holds. It re-admits this Mac after its identity was replaced. It lives only here (never in
// the device store, a log or a status reply) and is never derived from the vault keyring. A record may
// carry the `next` secret of a recovery whose commit is not confirmed yet, so a crash at any point leaves
// a secret that still matches the relay.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { keychainService, processFlavor } from "../flavor.js";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";

const TEST_SERVICE = /^cashu-next-relay-test\.[a-f0-9]{32}$/;
const LIMIT = 16 * 1024;

function unavailable(): never {
  throw new Error("relay_auth_unavailable");
}

function privateDir(path: string): string {
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

export interface RelayAuthAuthority {
  readonly dataDir: string;
  /** The host lock of `dataDir`: every read and write needs it held. */
  readonly lock: HostLock;
}

export interface RelayAuthSecret {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** The data dir's canonical path and the check every keyring access repeats (lock held, same dir). */
function bound(authority: RelayAuthAuthority): {
  readonly dir: string;
  readonly check: () => void;
} {
  const dir = privateDir(authority.dataDir);
  return {
    dir,
    check() {
      if (
        privateDir(authority.dataDir) !== dir ||
        !authority.lock.held ||
        authority.lock.path !== hostRunPaths(dir).lockPath
      )
        unavailable();
    },
  };
}

function make(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayAuthSecret {
  const { dir, check } = bound(authority);
  const account = `auth.${createHash("sha256").update(dir).digest("hex")}`;
  return {
    async get() {
      check();
      let bytes: Uint8Array | null = null;
      try {
        bytes = await keyring.get(service, account);
        check();
        if (!bytes?.length) return null;
        if (bytes.length > LIMIT) unavailable();
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
    async set(value) {
      const bytes = new TextEncoder().encode(value);
      if (!bytes.length || bytes.length > LIMIT) unavailable();
      try {
        check();
        await keyring.set(service, account, bytes);
        check();
      } catch {
        return unavailable();
      } finally {
        bytes.fill(0);
      }
    },
    async clear() {
      check();
      try {
        await keyring.set(service, account, new Uint8Array());
        check();
      } catch {
        return unavailable();
      }
    },
  };
}

const VAULT = /^[0-9a-f]{32}$/;
const RECOVERY_SECRET_BYTES = 32;
const RECOVERY_FORMAT = 1;

/** One vault's relay recovery secret; `next`: the one of a recovery not confirmed yet. */
export interface RelayRecoveryRecord {
  readonly current: Uint8Array;
  readonly next?: Uint8Array;
}

export interface RelayRecoverySecrets {
  get(vault: string): Promise<RelayRecoveryRecord | null>;
  set(vault: string, record: RelayRecoveryRecord): Promise<void>;
  clear(vault: string): Promise<void>;
}

function recoveryAccount(vault: string): string {
  if (!VAULT.test(vault)) unavailable();
  return `recovery.${vault}`;
}

function encodeRecovery(record: RelayRecoveryRecord): Uint8Array {
  const parts = record.next === undefined ? [record.current] : [record.current, record.next];
  if (parts.some((part) => part.length !== RECOVERY_SECRET_BYTES)) unavailable();
  const out = new Uint8Array(1 + parts.length * RECOVERY_SECRET_BYTES);
  out[0] = RECOVERY_FORMAT;
  parts.forEach((part, i) => {
    out.set(part, 1 + i * RECOVERY_SECRET_BYTES);
  });
  return out;
}

/** A stored value that does not decode reads as absent (no secret: reconnect is refused). */
function decodeRecovery(bytes: Uint8Array): RelayRecoveryRecord | null {
  const one = 1 + RECOVERY_SECRET_BYTES;
  if (bytes[0] !== RECOVERY_FORMAT || (bytes.length !== one && bytes.length !== one * 2 - 1))
    return null;
  const current = bytes.slice(1, one);
  return bytes.length === one ? { current } : { current, next: bytes.slice(one) };
}

function makeRecovery(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayRecoverySecrets {
  const { check } = bound(authority);
  return {
    async get(vault) {
      const account = recoveryAccount(vault);
      check();
      let bytes: Uint8Array | null = null;
      try {
        bytes = await keyring.get(service, account);
        check();
        return bytes?.length ? decodeRecovery(bytes) : null;
      } catch {
        return unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
    async set(vault, record) {
      const account = recoveryAccount(vault);
      const bytes = encodeRecovery(record);
      try {
        check();
        await keyring.set(service, account, bytes);
        check();
      } catch {
        return unavailable();
      } finally {
        bytes.fill(0);
      }
    },
    async clear(vault) {
      const account = recoveryAccount(vault);
      check();
      try {
        await keyring.set(service, account, new Uint8Array());
        check();
      } catch {
        return unavailable();
      }
    },
  };
}

function productionService(authority: RelayAuthAuthority): string {
  const hash = createHash("sha256").update(privateDir(authority.dataDir)).digest("hex");
  return keychainService(processFlavor(), "relay-auth", hash);
}

function testService(authority: RelayAuthAuthority, service: string): string {
  if (
    !TEST_SERVICE.test(service) ||
    !privateDir(authority.dataDir).startsWith(`${realpathSync.native(tmpdir())}/`)
  )
    unavailable();
  return service;
}

/** Dedicated OS service: the relay identity never enters the vault, banking or connector keyrings. */
export function createProductionRelayAuthSecret(authority: RelayAuthAuthority): RelayAuthSecret {
  return make(authority, productionService(authority), nativeOsKeyring());
}

/** The vaults' relay recovery secrets, in the relay identity's own OS service. */
export function createProductionRelayRecoverySecrets(
  authority: RelayAuthAuthority,
): RelayRecoverySecrets {
  return makeRecovery(authority, productionService(authority), nativeOsKeyring());
}

/** Strict synthetic keyring, refused outside a private subtree of the OS temp dir. */
export function createTestRelayAuthSecret(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayAuthSecret {
  return make(authority, testService(authority, service), keyring);
}

/** Strict synthetic recovery secrets, under the same refusals as `createTestRelayAuthSecret`. */
export function createTestRelayRecoverySecrets(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayRecoverySecrets {
  return makeRecovery(authority, testService(authority, service), keyring);
}
