// Relay membership writes (M4, S7): the vault document, its member documents and the recovery of the
// first admin, over the same REST client as the transport (rest.ts), so the Mac host and tests share it.
// The security rules (/firestore.rules) decide what each caller may do; this helper only shapes the
// writes the rules expect and answers a refusal by reading the server state back:
//
//   {root}/{vault}                     { createdAt, admins, recoveryHash? }   createVault, recoverAdmin
//   {root}/{vault}/members/{uid}       { device, role, addedAt }              createVault, addMember, removeMember
//   {root}/{vault}/recoveries/{uid}    { proof }                              recoverAdmin (never readable)
//
// Recovery: `recoveryHash` is sha256 of a secret (32 random bytes per vault, created by the Mac and kept
// only with the vault's recovery material, never derivable from anything a phone holds). Whoever holds it
// proves it once (`recoverAdmin`): ONE commit writes the proof doc, its own member doc as admin and the
// next hash, so the rules see a proof that matches the hash before the commit and is spent by it; the
// proof doc (unreadable, it opens nothing once the hash changed) is deleted right after.
//
// Every failure is a `FirestoreRestError` (value-free messages) except the refusals the outcomes name.
import { sha256 } from "@noble/hashes/sha2.js";
import type { DeviceId, VaultId } from "../../carrier.js";
import { DEVICE_RE } from "../../hlc.js";
import { checkRoot, vaultPath } from "./layout.js";
import {
  bytes,
  type FirestoreRest,
  FirestoreRestError,
  type FsDocument,
  type FsValue,
  type FsWrite,
  readStr,
  str,
  ts,
} from "./rest.js";

const MEMBERS = "members";
const RECOVERIES = "recoveries";
/** Firebase Auth uids: 1-128 characters, never a path separator (anonymous ones are 28 alphanumerics). */
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** sha256 output. */
const RECOVERY_HASH_BYTES = 32;
/** The rules' bounds on a recovery proof. */
const MIN_PROOF_BYTES = 16;
const MAX_PROOF_BYTES = 64;

export type RelayRole = "admin" | "member";

export interface RelayMember {
  readonly uid: string;
  readonly device: DeviceId;
  readonly role: RelayRole;
}

/**
 * `created`: this call made the vault and its first admin. `already-admin`: the vault exists and this uid
 * is its admin bound to this device (a retry whose first response was lost). `taken`: the vault exists and
 * this uid is not its admin (only an admin, or the recovery secret, can change that).
 */
export type CreateVaultOutcome = "created" | "already-admin" | "taken";

/**
 * `recovered`: this uid is admin again and the hash was replaced. `already-admin`: it was admin bound to
 * this device before the call (the hash was replaced all the same). `refused`: the proof did not match
 * the vault's current hash, the vault has none, or this uid still has a proof doc of an earlier recovery
 * (an admin deletes it, or the device recovers under a fresh anonymous uid).
 */
export type RecoverAdminOutcome = "recovered" | "already-admin" | "refused";

export interface FirestoreRelayAdminOptions {
  readonly rest: FirestoreRest;
  /** Collection prefix, default "vaults" (the rules match only it). */
  readonly root?: string;
  readonly now?: () => number;
}

/** The `recoveryHash` a vault document stores for a relay recovery secret. */
export function relayRecoveryHash(secret: Uint8Array): Uint8Array {
  checkProof(secret);
  return sha256(secret);
}

function invalid(): Error {
  return new Error("firestore_invalid_id");
}

function checkUid(uid: string): void {
  if (!UID_RE.test(uid)) throw invalid();
}

function checkDevice(device: DeviceId): void {
  if (!DEVICE_RE.test(device)) throw invalid();
}

function checkHash(hash: Uint8Array): void {
  if (hash.length !== RECOVERY_HASH_BYTES) throw new RangeError("invalid recoveryHash");
}

function checkProof(proof: Uint8Array): void {
  if (proof.length < MIN_PROOF_BYTES || proof.length > MAX_PROOF_BYTES) {
    throw new RangeError("invalid recovery proof");
  }
}

/** A refusal the rules or a precondition gave: the caller reads the server state to tell why. */
function refused(error: unknown): boolean {
  return (
    error instanceof FirestoreRestError &&
    (error.code === "permission-denied" ||
      error.code === "aborted" ||
      error.code === "failed-precondition" ||
      error.code === "not-found")
  );
}

function parseMember(doc: FsDocument, uid: string): RelayMember | undefined {
  try {
    const device = readStr(doc.fields.device);
    const role = readStr(doc.fields.role);
    if (!DEVICE_RE.test(device) || (role !== "admin" && role !== "member")) return undefined;
    return { uid, device, role };
  } catch {
    return undefined;
  }
}

export class FirestoreRelayAdmin {
  readonly #rest: FirestoreRest;
  readonly #root: string;
  readonly #now: () => number;

  constructor(options: FirestoreRelayAdminOptions) {
    this.#rest = options.rest;
    this.#root = checkRoot(options.root ?? "vaults");
    this.#now = options.now ?? Date.now;
  }

  /**
   * Creates the vault document and this uid's admin member document in one commit (the rules' bootstrap:
   * the vault must not exist yet). `recoveryHash` is optional until every creator writes it.
   */
  async createVault(
    vault: VaultId,
    input: { readonly uid: string; readonly device: DeviceId; readonly recoveryHash?: Uint8Array },
  ): Promise<CreateVaultOutcome> {
    const vaultDoc = vaultPath(this.#root, vault);
    checkUid(input.uid);
    checkDevice(input.device);
    if (input.recoveryHash) checkHash(input.recoveryHash);
    const at = this.#at();
    const fields: Record<string, FsValue> = {
      createdAt: at,
      admins: { arrayValue: { values: [str(input.uid)] } },
      ...(input.recoveryHash ? { recoveryHash: bytes(input.recoveryHash) } : {}),
    };
    try {
      await this.#rest.commit([
        { update: { name: vaultDoc, fields }, currentDocument: { exists: false } },
        this.#memberWrite(vault, input.uid, input.device, "admin", at, { exists: false }),
      ]);
      return "created";
    } catch (error) {
      if (!refused(error)) throw error;
      // A lost response retried finds its own documents; otherwise the vault is someone else's.
      return (await this.#isAdmin(vault, input.uid, input.device)) ? "already-admin" : "taken";
    }
  }

  /** Admin only: binds `uid` to `device` (a new member, or a re-grant after an identity loss). */
  async addMember(
    vault: VaultId,
    input: { readonly uid: string; readonly device: DeviceId; readonly role?: RelayRole },
  ): Promise<void> {
    checkUid(input.uid);
    checkDevice(input.device);
    await this.#rest.commit([
      this.#memberWrite(vault, input.uid, input.device, input.role ?? "member", this.#at()),
    ]);
  }

  /**
   * Admin only: removes `uid`'s member document and any recovery proof it left. The rules refuse an
   * admin removing itself (it may be the last admin): `permission-denied`.
   */
  async removeMember(vault: VaultId, uid: string): Promise<void> {
    checkUid(uid);
    await this.#rest.commit([
      { delete: this.#memberPath(vault, uid) },
      { delete: this.#recoveryPath(vault, uid) },
    ]);
  }

  /** Members only: every member document of the vault (malformed ones skipped). */
  async listMembers(vault: VaultId): Promise<RelayMember[]> {
    const docs = await this.#rest.runQuery(vaultPath(this.#root, vault), { collectionId: MEMBERS });
    const out: RelayMember[] = [];
    for (const doc of docs) {
      const name = this.#rest.relativeName(doc.name);
      const member = parseMember(doc, name.slice(name.lastIndexOf("/") + 1));
      if (member) out.push(member);
    }
    return out;
  }

  /**
   * Re-admits this uid with the recovery secret: the proof doc, the admin member document (created, or
   * replacing a demoted one or one bound to another device) and the vault's `recoveryHash` replaced by
   * `nextRecoveryHash`, in ONE commit (firestore.rules: the proof is single-use by construction); then
   * the proof doc is deleted. Safe to retry with the same `nextRecoveryHash`: a run whose commit landed
   * finds itself admin, re-writes the same hash and deletes the proof doc.
   */
  async recoverAdmin(
    vault: VaultId,
    input: {
      readonly uid: string;
      readonly device: DeviceId;
      readonly proof: Uint8Array;
      readonly nextRecoveryHash: Uint8Array;
    },
  ): Promise<RecoverAdminOutcome> {
    const vaultDoc = vaultPath(this.#root, vault);
    checkUid(input.uid);
    checkDevice(input.device);
    checkProof(input.proof);
    checkHash(input.nextRecoveryHash);
    const rotate: FsWrite = {
      update: { name: vaultDoc, fields: { recoveryHash: bytes(input.nextRecoveryHash) } },
      updateMask: { fieldPaths: ["recoveryHash"] },
      currentDocument: { exists: true },
    };
    const dropProof: FsWrite = { delete: this.#recoveryPath(vault, input.uid) };
    if (await this.#isAdmin(vault, input.uid, input.device)) {
      await this.#rest.commit([rotate, dropProof]);
      return "already-admin";
    }
    try {
      await this.#rest.commit([
        {
          update: {
            name: this.#recoveryPath(vault, input.uid),
            fields: { proof: bytes(input.proof) },
          },
          currentDocument: { exists: false },
        },
        // No precondition: a demoted member doc, or one bound to a lost device, is replaced.
        this.#memberWrite(vault, input.uid, input.device, "admin", this.#at()),
        rotate,
      ]);
    } catch (error) {
      if (!refused(error)) throw error;
      // A lost response whose commit landed finds itself admin; anything else was refused.
      if (!(await this.#isAdmin(vault, input.uid, input.device))) return "refused";
    }
    await this.#rest.commit([dropProof]);
    return "recovered";
  }

  /** Whether `uid` is the vault's admin bound to `device` (a refused read, as for a non-member: no). */
  async #isAdmin(vault: VaultId, uid: string, device: DeviceId): Promise<boolean> {
    let doc: FsDocument | undefined;
    try {
      doc = await this.#rest.get(this.#memberPath(vault, uid));
    } catch (error) {
      if (error instanceof FirestoreRestError && error.code === "permission-denied") return false;
      throw error;
    }
    const member = doc ? parseMember(doc, uid) : undefined;
    return member?.role === "admin" && member.device === device;
  }

  #memberWrite(
    vault: VaultId,
    uid: string,
    device: DeviceId,
    role: RelayRole,
    at: FsValue,
    precondition?: { exists: boolean },
  ): FsWrite {
    return {
      update: {
        name: this.#memberPath(vault, uid),
        fields: { device: str(device), role: str(role), addedAt: at },
      },
      ...(precondition ? { currentDocument: precondition } : {}),
    };
  }

  #memberPath(vault: VaultId, uid: string): string {
    return `${vaultPath(this.#root, vault)}/${MEMBERS}/${uid}`;
  }

  #recoveryPath(vault: VaultId, uid: string): string {
    return `${vaultPath(this.#root, vault)}/${RECOVERIES}/${uid}`;
  }

  #at(): FsValue {
    return ts(new Date(this.#now()).toISOString());
  }
}
