// The pairing link over the Firestore relay (M4 C2): the untrusted message link of QR pairing
// (devices/pairingLink.ts) carried by documents the security rules (/firestore.rules) guard:
//
//   {root}/{vault}/pairings/{sid}                    { inviter, joiner, expiresAt, createdAt }
//   {root}/{vault}/pairings/{sid}/messages/{n:04d}   { from, n, box, part, parts, createdAt }
//
// `sid` = hex(BLAKE2b-16(the QR's ephemeral public key)) (`pairingSessionId`), so only someone who saw
// the QR finds the session. The inviter (the Mac, the vault's admin) opens it; the first signed-in device
// that claims it (joiner null -> its uid, before expiry) is the only other party. Messages are immutable
// documents numbered per side, the inviter on even numbers and the joiner on odd ones, so the two never
// collide and each side reads exactly the peer's next number: strict ordering by construction. A box
// over 700 KiB (the rules' cap per document) is split into parts on consecutive numbers of its side.
// Delivery is by polling (default 1500 ms). A send whose response was lost is retried idempotently: the
// server state of number n decides (our own identical document = sent).
//
// The link only moves sealed bytes; every security property comes from the pairing protocol. Every
// failure is a `PairingLinkError` with a fixed, value-free message (no payload byte, uid or path).
import { blake2b } from "@noble/hashes/blake2.js";
import type { VaultId } from "../../carrier.js";
import { concat, toHex } from "../../crypto/encoding.js";
import type { PairingLink } from "../../devices/pairingLink.js";
import type { Invite } from "../../devices/pairingProtocol.js";
import { checkRoot, MAX_MESSAGE_N, MESSAGES, messagePath, pairingPath } from "./layout.js";
import {
  bytes,
  type FirestoreRest,
  FirestoreRestError,
  type FsDocument,
  type FsValue,
  type FsWrite,
  int,
  readBytes,
  readInt,
  readStr,
  str,
  ts,
} from "./rest.js";

/** The most box bytes one message document holds (the rules' cap, 700 KiB). */
export const PAIRING_PART_BYTES = 716_800;
/** The most parts one message is split into (about 44 MiB, far above any pairing message). */
export const MAX_PAIRING_PARTS = 64;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_RECEIVE_TIMEOUT_MS = 10 * 60_000;
/**
 * How long past `expiresAt` a receiver keeps polling: a message written just before expiry by a peer
 * whose clock differs from ours still arrives (the rules refuse writes after expiry by the server clock).
 */
const EXPIRY_GRACE_MS = 60_000;
/** Attempts per message part (the REST client retries each request once more on its own). */
const SEND_ATTEMPTS = 3;
/** Consecutive failed polls (each already retried by the REST client) before receive gives up. */
const MAX_FAILED_POLLS = 3;
/** Every n-th empty poll also reads the session, so a peer's cancel ends the wait early. */
const SESSION_CHECK_EVERY = 4;
/** Deletes per commit on close (the rules' access budget: one per delete, at most 20 per request). */
const DELETE_BATCH = 16;
/** Peer numbers beyond the last one seen that close also deletes (a write racing the close). */
const CLOSE_LOOKAHEAD = 4;

/**
 * `taken`: another device claimed the session (or this device may no longer read it).
 * `expired`: the session expired or no longer exists. `unavailable`: the relay could not be reached
 * (network, server, quota). `timeout`: no message arrived in time. `closed`: the link was closed
 * locally, or the peer closed the session. `refused`: the relay refused this device (not the vault's
 * admin, a lost identity). `malformed`: a document of the session does not have the expected shape or
 * order, or a message is too large for the session.
 */
export type PairingLinkErrorCode =
  | "taken"
  | "expired"
  | "unavailable"
  | "timeout"
  | "closed"
  | "refused"
  | "malformed";

export class PairingLinkError extends Error {
  readonly code: PairingLinkErrorCode;
  constructor(code: PairingLinkErrorCode) {
    super(`pairing link ${code}`);
    this.name = "PairingLinkError";
    this.code = code;
  }
}

export interface FirestorePairingLinkOptions {
  readonly rest: FirestoreRest;
  /** This device's anonymous uid (the identity `rest` authenticates as). */
  readonly uid: () => Promise<string>;
  readonly vault: VaultId;
  /** `pairingSessionId(invite)`. */
  readonly sessionId: string;
  readonly side: "inviter" | "joiner";
  /** Collection prefix, default "vaults" (the rules match only it). */
  readonly root?: string;
  /** Poll interval of `receive`, default 1500 ms. */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long one `receive` waits for the peer's next message, default 10 minutes. */
  readonly receiveTimeoutMs?: number;
}

/** The session id of an invite: hex(BLAKE2b-16(the QR's ephemeral public key)). */
export function pairingSessionId(invite: Pick<Invite, "ephemeralPublicKey">): string {
  return toHex(blake2b(invite.ephemeralPublicKey, { dkLen: 16 }));
}

interface Session {
  readonly inviter: string;
  readonly joiner: string | undefined;
  readonly expiresAt: number;
}

interface Message {
  readonly from: string;
  readonly box: Uint8Array;
  readonly part: number;
  readonly parts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function iso(ms: number): FsValue {
  return ts(new Date(ms).toISOString());
}

function readTime(value: FsValue | undefined): number {
  if (!value || !("timestampValue" in value)) throw new Error("bad timestamp");
  const ms = Date.parse(value.timestampValue);
  if (!Number.isFinite(ms)) throw new Error("bad timestamp");
  return ms;
}

function parseSession(doc: FsDocument): Session | undefined {
  try {
    const inviter = readStr(doc.fields.inviter);
    const joinerValue = doc.fields.joiner;
    let joiner: string | undefined;
    if (joinerValue && "stringValue" in joinerValue) joiner = joinerValue.stringValue;
    else if (!joinerValue || !("nullValue" in joinerValue)) return undefined;
    return { inviter, joiner, expiresAt: readTime(doc.fields.expiresAt) };
  } catch {
    return undefined;
  }
}

function parseMessage(doc: FsDocument, n: number): Message | undefined {
  try {
    const from = readStr(doc.fields.from);
    const box = readBytes(doc.fields.box);
    const part = readInt(doc.fields.part);
    const parts = readInt(doc.fields.parts);
    if (readInt(doc.fields.n) !== n) return undefined;
    if (parts < 1 || parts > MAX_PAIRING_PARTS || part < 0 || part >= parts) return undefined;
    if (box.length > PAIRING_PART_BYTES) return undefined;
    return { from, box, part, parts };
  } catch {
    return undefined;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A refusal the rules or a precondition gave: the server state tells why. */
function refusal(error: unknown): boolean {
  return (
    error instanceof FirestoreRestError &&
    (error.code === "permission-denied" ||
      error.code === "aborted" ||
      error.code === "failed-precondition" ||
      error.code === "not-found")
  );
}

/** A failure worth another attempt: the relay was unreachable or busy (or a non-REST failure). */
function transient(error: unknown): boolean {
  if (error instanceof PairingLinkError) return false;
  return (
    !(error instanceof FirestoreRestError) ||
    error.code === "unavailable" ||
    error.code === "resource-exhausted"
  );
}

/** The parts of a box: at most `PAIRING_PART_BYTES` each, one empty part for an empty box. */
function split(message: Uint8Array): Uint8Array[] {
  if (message.length === 0) return [message];
  const parts: Uint8Array[] = [];
  for (let at = 0; at < message.length; at += PAIRING_PART_BYTES) {
    parts.push(message.subarray(at, at + PAIRING_PART_BYTES));
  }
  return parts;
}

export class FirestorePairingLink implements PairingLink {
  readonly #rest: FirestoreRest;
  readonly #uid: () => Promise<string>;
  readonly #side: "inviter" | "joiner";
  readonly #path: string;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #receiveTimeoutMs: number;
  #me: string | undefined;
  #peer: string | undefined;
  #expiresAt: number | undefined;
  /** This side's next message number (inviter even, joiner odd). */
  #nextSend: number;
  /** The peer's next message number. */
  #nextReceive: number;
  #closed = false;

  constructor(options: FirestorePairingLinkOptions) {
    this.#rest = options.rest;
    this.#uid = options.uid;
    this.#side = options.side;
    this.#path = pairingPath(checkRoot(options.root ?? "vaults"), options.vault, options.sessionId);
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#receiveTimeoutMs = options.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT_MS;
    this.#nextSend = options.side === "inviter" ? 0 : 1;
    this.#nextReceive = options.side === "inviter" ? 1 : 0;
  }

  /** Inviter: creates pairings/{sid} { inviter: uid, joiner: null, expiresAt, createdAt }. */
  async open(expiresAt: number): Promise<void> {
    this.#only("inviter");
    this.#open();
    const me = await this.#self();
    const at = this.#now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= at) throw new PairingLinkError("expired");
    const fields: Record<string, FsValue> = {
      inviter: str(me),
      joiner: { nullValue: null },
      expiresAt: iso(expiresAt),
      createdAt: iso(at),
    };
    try {
      await this.#rest.commit([
        { update: { name: this.#path, fields }, currentDocument: { exists: false } },
      ]);
    } catch (error) {
      if (!refusal(error)) throw mapError(error);
      // A lost response retried finds its own session; anything else is not ours to open.
      const session = await this.#session().catch(() => undefined);
      if (!session) throw new PairingLinkError("refused");
      if (session.inviter !== me) throw new PairingLinkError("taken");
    }
    this.#expiresAt = expiresAt;
  }

  /**
   * Joiner: claims the session (joiner null -> this uid, guarded by the document's updateTime so two
   * claimers cannot both win). A claim whose response was lost finds itself the joiner and succeeds.
   */
  async claim(): Promise<void> {
    this.#only("joiner");
    this.#open();
    const me = await this.#self();
    const doc = await this.#claimRead();
    const before = this.#decide(doc, me);
    if (before === "claimed") return;
    let failure: unknown;
    try {
      await this.#rest.commit([
        {
          update: { name: this.#path, fields: { joiner: str(me) } },
          updateMask: { fieldPaths: ["joiner"] },
          currentDocument: doc.updateTime ? { updateTime: doc.updateTime } : { exists: true },
        },
      ]);
      return;
    } catch (error) {
      if (!refusal(error) && !transient(error)) throw mapError(error);
      failure = error;
    }
    // The server state decides: our own claim landed, another device won, or the session expired.
    const after = this.#decide(await this.#claimRead(), me);
    if (after === "claimed") return;
    // Still unclaimed: a refusal can only be the server's clock past expiry.
    throw new PairingLinkError(transient(failure) ? "unavailable" : "expired");
  }

  /** Inviter: the uid that claimed the session, once claimed. */
  async joinerUid(): Promise<string | undefined> {
    this.#only("inviter");
    if (this.#peer !== undefined) return this.#peer;
    let session: Session | undefined;
    try {
      session = await this.#session();
    } catch (error) {
      throw this.#sessionError(error);
    }
    if (session?.joiner !== undefined) this.#peer = session.joiner;
    return this.#peer;
  }

  async send(message: Uint8Array): Promise<void> {
    this.#open();
    const me = await this.#self();
    const parts = split(message);
    const last = this.#nextSend + 2 * (parts.length - 1);
    if (parts.length > MAX_PAIRING_PARTS || last > MAX_MESSAGE_N) {
      throw new PairingLinkError("malformed");
    }
    if (this.#expiresAt !== undefined && this.#now() >= this.#expiresAt) {
      throw new PairingLinkError("expired");
    }
    // The numbers advance only once every part is written: a retried send rewrites the same numbers.
    let n = this.#nextSend;
    for (const [i, part] of parts.entries()) {
      await this.#writePart(me, n, part, i, parts.length);
      n += 2;
    }
    this.#nextSend = n;
  }

  /**
   * The peer's next message (its parts reassembled in order); waits by polling. `signal` stops the
   * wait: once it aborts, no further relay request is made and the call rejects with `closed` (a
   * request already in flight still completes, its answer is dropped and no message is consumed).
   * The link itself stays open.
   */
  async receive(options: { readonly signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const { signal } = options;
    const live = () => {
      this.#open();
      if (signal?.aborted) throw new PairingLinkError("closed");
    };
    live();
    const deadline = this.#now() + this.#receiveTimeoutMs;
    const chunks: Uint8Array[] = [];
    let parts: number | undefined;
    let n = this.#nextReceive;
    let empty = 0;
    let failed = 0;
    for (;;) {
      live();
      if (n > MAX_MESSAGE_N) throw new PairingLinkError("malformed");
      let doc: FsDocument | undefined;
      try {
        doc = await this.#rest.get(messagePath(this.#path, n));
        failed = 0;
      } catch (error) {
        live();
        if (!transient(error)) throw this.#sessionError(error);
        if (++failed >= MAX_FAILED_POLLS) throw new PairingLinkError("unavailable");
      }
      live();
      if (doc) {
        const message = parseMessage(doc, n);
        if (!message) throw new PairingLinkError("malformed");
        await this.#checkPeer(message.from);
        live();
        if (parts === undefined) {
          if (message.part !== 0) throw new PairingLinkError("malformed");
          parts = message.parts;
        } else if (message.parts !== parts || message.part !== chunks.length) {
          throw new PairingLinkError("malformed");
        }
        chunks.push(message.box);
        n += 2;
        if (chunks.length === parts) {
          this.#nextReceive = n;
          return chunks.length === 1 ? (chunks[0] as Uint8Array) : concat(...chunks);
        }
        continue;
      }
      const t = this.#now();
      if (this.#expiresAt !== undefined && t >= this.#expiresAt + EXPIRY_GRACE_MS) {
        throw new PairingLinkError("expired");
      }
      if (t >= deadline) throw new PairingLinkError("timeout");
      if (++empty % SESSION_CHECK_EVERY === 0) {
        await this.#checkSession();
        live();
      }
      await this.#pause(this.#pollMs, signal);
    }
  }

  /** The poll interval, cut short when `signal` aborts (the caller's next check then throws). */
  async #pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) return this.#sleep(ms);
    if (signal.aborted) return;
    let onAbort = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.#sleep(ms), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Ends the link: a pending or later `receive` / `send` fails with `closed`. The inviter (the vault's
   * admin) also deletes the session's messages and the session document; a joiner cannot (the rules
   * let only an admin delete) and stops locally.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#side !== "inviter") return;
    const ownParity = this.#nextSend % 2;
    let nextPeer = this.#nextReceive;
    try {
      for (;;) {
        const docs = await this.#rest.runQuery(this.#path, {
          collectionId: MESSAGES,
          select: ["__name__"],
          limit: DELETE_BATCH,
        });
        if (docs.length === 0) break;
        const writes: FsWrite[] = [];
        for (const doc of docs) {
          const name = this.#rest.relativeName(doc.name);
          const n = Number(name.slice(name.lastIndexOf("/") + 1));
          if (Number.isSafeInteger(n) && n % 2 !== ownParity && n + 2 > nextPeer) nextPeer = n + 2;
          writes.push({ delete: name });
        }
        await this.#rest.commit(writes);
      }
      // The session goes last (listing messages needs it), with the peer's next few numbers: a message
      // written between the last listing and this commit is deleted too; after it none can be written.
      const writes: FsWrite[] = [{ delete: this.#path }];
      for (let i = 0, n = nextPeer; i < CLOSE_LOOKAHEAD && n <= MAX_MESSAGE_N; i++, n += 2) {
        writes.push({ delete: messagePath(this.#path, n) });
      }
      await this.#rest.commit(writes);
    } catch (error) {
      throw this.#sessionError(error);
    }
  }

  async #writePart(
    me: string,
    n: number,
    box: Uint8Array,
    part: number,
    parts: number,
  ): Promise<void> {
    const path = messagePath(this.#path, n);
    const fields: Record<string, FsValue> = {
      from: str(me),
      n: int(n),
      box: bytes(box),
      part: int(part),
      parts: int(parts),
      createdAt: iso(this.#now()),
    };
    let failure: unknown;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      this.#open();
      if (attempt > 0) await this.#sleep(this.#pollMs);
      try {
        await this.#rest.commit([
          { update: { name: path, fields }, currentDocument: { exists: false } },
        ]);
        return;
      } catch (error) {
        failure = error;
      }
      // A lost response, or a retry of a whole send: the document at n decides.
      let existing: FsDocument | undefined;
      try {
        existing = await this.#rest.get(path);
      } catch (error) {
        if (transient(error)) continue;
        throw this.#sessionError(error);
      }
      if (existing) {
        const written = parseMessage(existing, n);
        if (
          written &&
          written.from === me &&
          written.part === part &&
          written.parts === parts &&
          equalBytes(written.box, box)
        ) {
          return;
        }
        throw new PairingLinkError("malformed");
      }
      if (!transient(failure)) throw this.#sessionError(failure);
    }
    throw this.#sessionError(failure);
  }

  /** Joiner's read before and after its claim: denied = claimed by another, missing = gone. */
  async #claimRead(): Promise<FsDocument> {
    let doc: FsDocument | undefined;
    try {
      doc = await this.#rest.get(this.#path);
    } catch (error) {
      if (error instanceof FirestoreRestError && error.code === "permission-denied") {
        throw new PairingLinkError("taken");
      }
      throw mapError(error);
    }
    if (!doc) throw new PairingLinkError("expired");
    return doc;
  }

  /** "claimed" when this uid is the joiner, "open" when the claim may proceed; throws otherwise. */
  #decide(doc: FsDocument, me: string): "claimed" | "open" {
    const session = parseSession(doc);
    if (!session) throw new PairingLinkError("malformed");
    this.#peer = session.inviter;
    this.#expiresAt = session.expiresAt;
    if (session.joiner === me) return "claimed";
    if (session.joiner !== undefined) throw new PairingLinkError("taken");
    if (this.#now() >= session.expiresAt) throw new PairingLinkError("expired");
    return "open";
  }

  async #session(): Promise<Session | undefined> {
    const doc = await this.#rest.get(this.#path);
    if (!doc) return undefined;
    const session = parseSession(doc);
    if (!session) throw new PairingLinkError("malformed");
    return session;
  }

  /** The sender of a peer message must be the session's other party. */
  async #checkPeer(from: string): Promise<void> {
    const peer = this.#side === "inviter" ? await this.joinerUid() : this.#peer;
    if (peer === undefined || from !== peer) throw new PairingLinkError("malformed");
  }

  /** During a wait: a session that is gone (the peer cancelled) or no longer ours ends it. */
  async #checkSession(): Promise<void> {
    let session: Session | undefined;
    try {
      session = await this.#session();
    } catch (error) {
      if (transient(error)) return;
      throw this.#sessionError(error);
    }
    if (!session) throw new PairingLinkError("closed");
    const me = await this.#self();
    if (session.inviter !== me && session.joiner !== me) throw new PairingLinkError("closed");
  }

  /** A failure of a read or write of the open session. */
  #sessionError(error: unknown): PairingLinkError {
    if (error instanceof PairingLinkError) return error;
    if (
      error instanceof FirestoreRestError &&
      (error.code === "permission-denied" || error.code === "not-found")
    ) {
      // The rules refuse a party only once the session expired or is gone.
      const expired = this.#expiresAt !== undefined && this.#now() >= this.#expiresAt;
      return new PairingLinkError(expired ? "expired" : "closed");
    }
    return mapError(error);
  }

  async #self(): Promise<string> {
    if (this.#me === undefined) {
      try {
        this.#me = await this.#uid();
      } catch (error) {
        throw mapError(error);
      }
    }
    return this.#me;
  }

  #open(): void {
    if (this.#closed) throw new PairingLinkError("closed");
  }

  #only(side: "inviter" | "joiner"): void {
    if (this.#side !== side) throw new Error("pairing_link_wrong_side");
  }
}

function mapError(error: unknown): PairingLinkError {
  if (error instanceof PairingLinkError) return error;
  if (error instanceof FirestoreRestError) {
    switch (error.code) {
      case "permission-denied":
      case "unauthenticated":
        return new PairingLinkError("refused");
      case "not-found":
        return new PairingLinkError("expired");
      case "invalid-argument":
        return new PairingLinkError("malformed");
      default:
        return new PairingLinkError("unavailable");
    }
  }
  return new PairingLinkError("unavailable");
}
