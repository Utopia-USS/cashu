import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import { nativeOsKeyring, type OsKeyringPort } from "./native.js";

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
const TEST_SERVICE = /^cashu-next-banking-test\.[a-f0-9]{32}$/;
const LIMIT = 64 * 1024;

function unavailable(): never {
  throw new Error("banking_secrets_unavailable");
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

export interface BankingSecretAuthority {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly profileId: string;
  /** Checked at every await boundary, including after a keyring read. */
  isCurrent(profileId: string): boolean;
  isOwnerAction(): boolean;
}
export interface BankingSecretStore {
  get(kind: "credentials" | "sessions"): Promise<string | null>;
  set(kind: "credentials" | "sessions", value: string): Promise<void>;
  clear(kind: "credentials" | "sessions"): Promise<void>;
  /** Stable only within this private data-dir/profile namespace. */
  readonly namespace: string;
}

function make(
  authority: BankingSecretAuthority,
  service: string,
  keyring: OsKeyringPort,
): BankingSecretStore {
  const dir = privateDir(authority.dataDir);
  const profile = authority.profileId;
  if (!PROFILE.test(profile)) unavailable();
  function check(write: boolean, kind: "credentials" | "sessions"): void {
    if (
      privateDir(authority.dataDir) !== dir ||
      !authority.lock.held ||
      authority.lock.path !== hostRunPaths(dir).lockPath ||
      !authority.isCurrent(profile) ||
      (write && kind === "credentials" && !authority.isOwnerAction())
    )
      unavailable();
  }
  function key(kind: "credentials" | "sessions") {
    // Credentials and sessions are separate device-only records, scoped to the exact profile.
    return `${kind}.${createHash("sha256").update(`${dir}\0${profile}\0${kind}`).digest("hex")}`;
  }
  return {
    namespace: `${service}:${profile}`,
    async get(kind) {
      check(false, kind);
      let bytes: Uint8Array | null;
      try {
        bytes = await keyring.get(service, key(kind));
      } catch {
        return unavailable();
      }
      try {
        check(false, kind);
        if (!bytes || bytes.length === 0) return null;
        if (bytes.length > LIMIT) unavailable();
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return unavailable();
      } finally {
        bytes?.fill(0);
      }
    },
    async set(kind, value) {
      const bytes = new TextEncoder().encode(value);
      if (bytes.length === 0 || bytes.length > LIMIT) unavailable();
      try {
        check(true, kind);
        await keyring.set(service, key(kind), bytes);
        check(true, kind);
      } catch {
        return unavailable();
      } finally {
        bytes.fill(0);
      }
    },
    async clear(kind) {
      check(true, kind);
      try {
        await keyring.set(service, key(kind), new Uint8Array());
        check(true, kind);
      } catch {
        return unavailable();
      }
    },
  };
}

/** Native OS Keyring service separate from sync identities and connector secrets. */
export function createProductionBankingSecrets(
  authority: BankingSecretAuthority,
): BankingSecretStore {
  const hash = createHash("sha256").update(privateDir(authority.dataDir)).digest("hex");
  return make(authority, `cashu.banking.v1.${hash}`, nativeOsKeyring());
}

/** Synthetic keyring, refused outside a private TMPDIR subtree. */
export function createTestBankingSecrets(
  authority: BankingSecretAuthority,
  service: string,
  keyring: OsKeyringPort,
): BankingSecretStore {
  if (
    !TEST_SERVICE.test(service) ||
    !privateDir(authority.dataDir).startsWith(
      `${realpathSync.native(process.env.TMPDIR || "/private/tmp")}/`,
    )
  )
    unavailable();
  return make(authority, service, keyring);
}
