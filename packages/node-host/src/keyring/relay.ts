// The sync relay identity of one data dir (M4): the anonymous Firebase uid and its refresh token, one
// record per data dir (every vault of this Mac shares it), in its own OS keyring service
// `<prefix>.relay-auth.v1.<sha256(data dir)>`. The refresh token is a secret: it never leaves this
// boundary except to the relay's own token endpoint; errors are one fixed code.
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

function make(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayAuthSecret {
  const dir = privateDir(authority.dataDir);
  const account = `auth.${createHash("sha256").update(dir).digest("hex")}`;
  function check(): void {
    if (
      privateDir(authority.dataDir) !== dir ||
      !authority.lock.held ||
      authority.lock.path !== hostRunPaths(dir).lockPath
    )
      unavailable();
  }
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

/** Dedicated OS service: the relay identity never enters the vault, banking or connector keyrings. */
export function createProductionRelayAuthSecret(authority: RelayAuthAuthority): RelayAuthSecret {
  const hash = createHash("sha256").update(privateDir(authority.dataDir)).digest("hex");
  return make(authority, keychainService(processFlavor(), "relay-auth", hash), nativeOsKeyring());
}

/** Strict synthetic keyring, refused outside a private subtree of the OS temp dir. */
export function createTestRelayAuthSecret(
  authority: RelayAuthAuthority,
  service: string,
  keyring: OsKeyringPort,
): RelayAuthSecret {
  if (
    !TEST_SERVICE.test(service) ||
    !privateDir(authority.dataDir).startsWith(`${realpathSync.native(tmpdir())}/`)
  )
    unavailable();
  return make(authority, service, keyring);
}
