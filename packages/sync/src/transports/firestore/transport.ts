// Firestore relay transport (M4-A): segments as a meta document plus chunk documents (layout.ts), over
// the REST client (rest.ts), so the same code runs on the Mac host and the phone.
//
// Guarantees the engine relies on:
// - `list` reports only committed sizes (the meta documents), never bytes of a chunk not yet committed.
// - `append` is all or nothing for readers: chunks are written first, the meta's new size last, and
//   every commit of an append carries the meta precondition (`exists: false` or the updateTime read at
//   the start) and changes the meta (`rev` + 1: Firestore keeps the updateTime of a write that changes
//   nothing, which would let a clone's precondition pass). So a stale or concurrent writer of the same
//   segment fails on its next commit (`offset-conflict`) and never writes after a later append succeeded.
// - Because of that, an interrupted append can only leave orphan chunks that are OLDER than any
//   committed chunk covering the same bytes; `read` takes, at each position, the most recently written
//   chunk covering it and never returns bytes beyond the meta's size.
// - Every failure is a `TransportError`: `offset-conflict` for a size mismatch or a precondition that
//   no longer holds, `unavailable` for everything else, so the engine skips the remote instead of
//   failing the pass. `unavailable` carries its reason (errors.ts): `outage` only for the network, a
//   timeout, 5xx and quota; `refused` for permission (this device is no longer a member),
//   `identity-lost`, and `protocol` for everything else (refused credentials, decode, a gap). Only an
//   outage lets the pinned leader go on without the relay (D6). Messages are fixed strings.
// - `status()` says why the last call failed (cleared by the next success). The identity is polled
//   through `uid()` (cached by `AnonymousAuth`, no request): a uid other than the one of this handle's
//   first successful call means the anonymous identity was replaced (`relay-identity-lost`) until a
//   call succeeds under the new one (the Mac granted it membership). Across restarts the signal is
//   `AnonymousAuth.onIdentityLost` (the wiring persists it).
import type {
  DeviceId,
  SegmentInfo,
  Transport,
  TransportConsistency,
  VaultId,
} from "../../carrier.js";
import { TransportError, type TransportUnavailableReason } from "../../errors.js";
import {
  CHUNKS,
  type Chunk,
  checkRoot,
  chunkFields,
  chunkPath,
  metaFields,
  parseChunk,
  parseMeta,
  SEGMENTS,
  type SegmentMeta,
  segmentPath,
  vaultPath,
} from "./layout.js";
import {
  type FirestoreRest,
  FirestoreRestError,
  type FsPrecondition,
  type FsWrite,
  int,
} from "./rest.js";

/** The rules' chunk limit (700 KiB): a chunk document stays well under Firestore's 1 MiB. */
const MAX_CHUNK_BYTES = 716_800;
const DEFAULT_COMMIT_BYTES = 6 * 1024 * 1024;
/** Raw bytes per commit: base64 (4/3) plus names keeps the request under Firestore's 10 MiB. */
const MAX_COMMIT_BYTES = 7 * 1024 * 1024;
/**
 * Chunk writes per append commit (the meta is one more write). Firestore allows at most 20 document
 * access calls per batched-write request; caching of repeated accesses is not guaranteed, so this budget
 * counts every call (firestore.rules header): the meta update costs 1 and each chunk 3, and
 * 1 + 6 x 3 = 19. At the 700 KiB chunk size this cap binds before the 6 MiB byte cap (4.1 MiB).
 */
export const MAX_CHUNKS_PER_COMMIT = 6;
/** Deletes per purge commit: each one costs the rules' admin check (1 access call), 20 per request. */
export const PURGE_DELETES_PER_COMMIT = 20;
/** Names only: `__name__` projection (an empty projection would return every field, chunk bytes included). */
const NAME_ONLY = ["__name__"];
/** Sub-collections of a vault the purge also clears (firestore.rules: an admin may delete them). */
const MEMBERS = "members";
const RECOVERIES = "recoveries";
const PAIRINGS = "pairings";
const MESSAGES = "messages";
const EMPTY = new Uint8Array(0);

export interface FirestoreTransportOptions {
  readonly rest: FirestoreRest;
  /** The writer uid stored in the meta documents (`AnonymousAuth.uid`). */
  readonly uid: () => Promise<string>;
  /** Collection prefix, default "vaults" (the rules match only it); tests pass their own. */
  readonly root?: string;
  /** Default 716_800 (700 KiB), at most that. */
  readonly maxChunkBytes?: number;
  /** Raw bytes per commit, default 6 MiB, at most 7 MiB. */
  readonly maxCommitBytes?: number;
  /** Chunk writes per commit besides the meta, default and at most 6 (the rules' access budget). */
  readonly maxChunksPerCommit?: number;
  /**
   * Default `eventual`. Declare `linearizable` only where `checkPropagationClaim` passed against the
   * backend (the emulator contract test).
   */
  readonly consistency?: TransportConsistency;
  readonly now?: () => number;
}

/** Why the relay last failed, value-free (the host and the phone map it to copy). */
export type RelayErrorKind = "unavailable" | "quota" | "forbidden" | "relay-identity-lost";

export interface RelayStatus {
  /** When a call last succeeded. */
  readonly lastOk?: number;
  /** Why the most recent call failed; undefined once a later call succeeded. */
  readonly lastError?: RelayErrorKind;
  /** When a call last failed (kept after a success, for "last problem at"). */
  readonly lastErrorAt?: number;
}

type Verb = "read" | "write";

export class FirestoreTransport implements Transport {
  readonly consistency: TransportConsistency;
  readonly #rest: FirestoreRest;
  readonly #uid: () => Promise<string>;
  readonly #root: string;
  readonly #maxChunk: number;
  readonly #maxCommit: number;
  readonly #maxChunksPerCommit: number;
  readonly #now: () => number;
  #status: RelayStatus = {};
  /** The uid of the last successful call; a different one later means the identity was replaced. */
  #identity: string | undefined;
  #identityLost = false;
  #purgeCommits = 0;

  constructor(options: FirestoreTransportOptions) {
    this.#rest = options.rest;
    this.#uid = options.uid;
    this.#root = checkRoot(options.root ?? "vaults");
    this.#maxChunk = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
    this.#maxCommit = options.maxCommitBytes ?? DEFAULT_COMMIT_BYTES;
    if (!Number.isSafeInteger(this.#maxChunk) || this.#maxChunk < 1) {
      throw new RangeError("invalid maxChunkBytes");
    }
    if (this.#maxChunk > MAX_CHUNK_BYTES) throw new RangeError("invalid maxChunkBytes");
    if (!Number.isSafeInteger(this.#maxCommit) || this.#maxCommit < this.#maxChunk) {
      throw new RangeError("invalid maxCommitBytes");
    }
    if (this.#maxCommit > MAX_COMMIT_BYTES) throw new RangeError("invalid maxCommitBytes");
    this.#maxChunksPerCommit = options.maxChunksPerCommit ?? MAX_CHUNKS_PER_COMMIT;
    if (
      !Number.isSafeInteger(this.#maxChunksPerCommit) ||
      this.#maxChunksPerCommit < 1 ||
      this.#maxChunksPerCommit > MAX_CHUNKS_PER_COMMIT
    ) {
      throw new RangeError("invalid maxChunksPerCommit");
    }
    this.consistency = options.consistency ?? { kind: "eventual" };
    this.#now = options.now ?? Date.now;
  }

  status(): RelayStatus {
    return this.#status;
  }

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    const parent = vaultPath(this.#root, vault);
    return this.#call("read", async () => {
      const docs = await this.#rest.runQuery(parent, {
        collectionId: SEGMENTS,
        select: ["device", "seg", "size"],
      });
      const out: SegmentInfo[] = [];
      for (const doc of docs) {
        const meta = parseMeta(doc);
        // Size 0: an interrupted first append created the meta, nothing is committed yet.
        if (meta && meta.size > 0)
          out.push({ device: meta.device, seg: meta.seg, size: meta.size });
      }
      return out;
    });
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    const path = segmentPath(this.#root, vault, device, seg);
    const from = Number.isSafeInteger(fromOffset) ? Math.max(0, fromOffset) : 0;
    return this.#call("read", async () => {
      const meta = await this.#meta(path);
      if (!meta || from >= meta.size) return EMPTY;
      // The response carries `[from, size)` plus the head of the first chunk (less than a chunk,
      // at most `from`), as base64 (4/3): its timeout grows with it so a multi-megabyte first pull
      // on a slow link can finish.
      const head = Math.min(from, this.#maxChunk);
      const expected = Math.ceil(((meta.size - from + head) * 4) / 3);
      const docs = await this.#rest.runQuery(
        path,
        {
          collectionId: CHUNKS,
          // The inequality field is also the order: a single-field index, no composite one needed.
          where: [{ field: "end", op: "GREATER_THAN", value: int(from) }],
          orderBy: [{ field: "end" }],
        },
        { timeoutMs: this.#rest.timeoutFor(expected) },
      );
      const chunks: Chunk[] = [];
      for (const doc of docs) {
        const c = parseChunk(doc);
        if (c && c.end > c.start && c.start < meta.size) chunks.push(c);
      }
      return assemble(chunks, from, meta.size);
    });
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const path = segmentPath(this.#root, vault, device, seg);
    await this.#call("write", async (writer) => {
      const meta = await this.#meta(path);
      if (atOffset !== (meta?.size ?? 0)) {
        throw new TransportError("offset-conflict", "append offset is not the segment size");
      }
      if (bytes.length === 0) return;
      // Encoded only after the offset check: a conflict wastes no base64 of the whole append.
      const chunks = this.#chunks(path, atOffset, bytes);
      // The rules create a meta empty (rev 1) and only an update grows it: a new segment whose bytes fit
      // one commit takes one more, meta-only commit that sets the size.
      if (!meta && chunks.length === 1) chunks.push([]);
      let precondition: FsPrecondition = meta?.updateTime
        ? { updateTime: meta.updateTime }
        : { exists: false };
      let rev = meta?.rev ?? 0;
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        rev++;
        const metaWrite: FsWrite = {
          update: {
            name: path,
            fields: metaFields({
              device,
              seg,
              size: last ? atOffset + bytes.length : atOffset,
              writer,
              at: this.#now(),
              rev,
            }),
          },
          currentDocument: precondition,
        };
        // The REST client sizes the timeout from the body (several MiB on a slow link).
        const result = await this.#rest.commit([metaWrite, ...(chunks[i] ?? [])]);
        const updateTime = result.updateTimes[0] ?? result.commitTime;
        precondition = { updateTime };
      }
    });
  }

  /**
   * Admin only (the host): removes what the vault holds at the relay but the vault document itself (a
   * tombstone, firestore.rules) and the caller's own member document, at most 20 deletes per commit
   * (the rules' access budget), names only (no chunk bytes downloaded). Order (S5): first every other
   * member document, so no other device can upload again while the purge runs (it reads 403 from then
   * on); then every recovery proof doc; then every pairing with its messages (messages first); then the
   * segments. A segment's chunks go before its meta, in the same commit when they fit, so a segment of
   * up to 19 chunks disappears atomically and
   * an interrupted purge leaves every unfinished segment findable by its meta for the retry (readers
   * may see a gap there: `unavailable` until the purge is retried). `purgeCommits` says how far a
   * failed purge got: 0 = nothing was deleted, more = partly done (the host answers "retry").
   */
  async purge(vault: VaultId): Promise<void> {
    const parent = vaultPath(this.#root, vault);
    this.#purgeCommits = 0;
    await this.#call("write", async (uid) => {
      let batch: FsWrite[] = [];
      const flush = async () => {
        if (batch.length > 0) {
          await this.#rest.commit(batch);
          this.#purgeCommits += 1;
        }
        batch = [];
      };
      const remove = async (name: string) => {
        batch.push({ delete: name });
        if (batch.length >= PURGE_DELETES_PER_COMMIT) await flush();
      };
      const names = async (path: string, collectionId: string) =>
        (await this.#rest.runQuery(path, { collectionId, select: NAME_ONLY })).map((d) => d.name);
      const own = `${parent}/${MEMBERS}/${uid}`;
      for (const name of await names(parent, MEMBERS)) {
        if (this.#rest.relativeName(name) !== own) await remove(name);
      }
      // The members go in commits of their own, before anything else is touched.
      await flush();
      for (const name of await names(parent, RECOVERIES)) await remove(name);
      for (const pairing of await names(parent, PAIRINGS)) {
        for (const message of await names(this.#rest.relativeName(pairing), MESSAGES))
          await remove(message);
        await remove(pairing);
      }
      await flush();
      const segments = await this.#rest.runQuery(parent, {
        collectionId: SEGMENTS,
        select: NAME_ONLY,
      });
      for (const s of segments) {
        const segment = this.#rest.relativeName(s.name);
        const chunks = await this.#rest.runQuery(segment, {
          collectionId: CHUNKS,
          select: NAME_ONLY,
        });
        if (batch.length + chunks.length + 1 > PURGE_DELETES_PER_COMMIT) await flush();
        for (const c of chunks) {
          batch.push({ delete: c.name });
          if (batch.length >= PURGE_DELETES_PER_COMMIT) await flush();
        }
        batch.push({ delete: s.name });
        if (batch.length >= PURGE_DELETES_PER_COMMIT) await flush();
      }
      await flush();
    });
  }

  /** Delete commits that landed during the last `purge` (also when it failed later). */
  get purgeCommits(): number {
    return this.#purgeCommits;
  }

  /** The chunk writes of an append, grouped into commits (each group is one commit plus the meta). */
  #chunks(path: string, atOffset: number, bytes: Uint8Array): FsWrite[][] {
    const groups: FsWrite[][] = [];
    let group: FsWrite[] = [];
    let groupBytes = 0;
    if (!Number.isSafeInteger(atOffset) || atOffset < 0) return groups;
    for (let off = 0; off < bytes.length; off += this.#maxChunk) {
      const data = bytes.subarray(off, Math.min(bytes.length, off + this.#maxChunk));
      if (
        group.length > 0 &&
        (groupBytes + data.length > this.#maxCommit || group.length >= this.#maxChunksPerCommit)
      ) {
        groups.push(group);
        group = [];
        groupBytes = 0;
      }
      const start = atOffset + off;
      group.push({ update: { name: chunkPath(path, start), fields: chunkFields(start, data) } });
      groupBytes += data.length;
    }
    if (group.length > 0) groups.push(group);
    return groups;
  }

  async #meta(path: string): Promise<SegmentMeta | undefined> {
    const doc = await this.#rest.get(path);
    if (!doc) return undefined;
    const meta = parseMeta(doc);
    if (!meta) {
      throw new TransportError("unavailable", "firestore segment meta is unreadable", "protocol");
    }
    return meta;
  }

  /** A uid other than the last successful call's means the anonymous identity was replaced. */
  #checkIdentity(uid: string): void {
    if (this.#identity !== undefined && uid !== this.#identity) this.#identityLost = true;
  }

  /**
   * Runs one transport call with the caller's uid (the meta's writer), records the outcome and maps
   * every failure to a `TransportError`.
   */
  async #call<T>(verb: Verb, run: (uid: string) => Promise<T>): Promise<T> {
    let uid: string | undefined;
    try {
      uid = await this.#uid();
      this.#checkIdentity(uid);
      const result = await run(uid);
      this.#ok(uid);
      return result;
    } catch (e) {
      throw await this.#fail(e, verb, uid);
    }
  }

  /** The server answered: this uid works, any earlier failure is over. */
  #ok(uid: string): void {
    this.#identity = uid;
    this.#identityLost = false;
    const { lastErrorAt } = this.#status;
    this.#status = {
      lastOk: this.#now(),
      ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
    };
  }

  async #fail(e: unknown, verb: Verb, uid: string | undefined): Promise<TransportError> {
    if (e instanceof TransportError && e.code === "offset-conflict" && uid !== undefined) {
      this.#ok(uid);
      return e;
    }
    if (
      verb === "write" &&
      e instanceof FirestoreRestError &&
      (e.code === "failed-precondition" || e.code === "aborted")
    ) {
      // The meta changed since it was read: another writer (a cloned device) or our own commit whose
      // response was lost and was retried. Either way nothing of this call is visible to readers.
      if (uid !== undefined) this.#ok(uid);
      return new TransportError("offset-conflict", "segment changed during append");
    }
    let kind: RelayErrorKind = "unavailable";
    let message = "firestore relay unavailable";
    // Only a failure of the network or the service is an outage; an answer we cannot use is not.
    let reason: TransportUnavailableReason =
      e instanceof FirestoreRestError && e.code === "unavailable" ? "outage" : "protocol";
    if (e instanceof FirestoreRestError && e.code === "permission-denied") {
      kind = "forbidden";
      reason = "refused";
      message = "firestore relay refused access";
      // A 401 inside the call may have refreshed into a new anonymous user (identity lost) whose
      // token was then refused: the session is fresh, so this `uid()` is answered from the cache.
      try {
        this.#checkIdentity(await this.#uid());
      } catch {
        // No identity now: the refusal stays `forbidden`.
      }
    } else if (e instanceof FirestoreRestError && e.code === "resource-exhausted") {
      kind = "quota";
      message = "firestore relay quota exhausted";
      reason = "outage";
    } else if (e instanceof TransportError) {
      message = e.message;
    }
    if (this.#identityLost) {
      kind = "relay-identity-lost";
      reason = "identity-lost";
    }
    this.#status = { ...this.#status, lastError: kind, lastErrorAt: this.#now() };
    return new TransportError("unavailable", message, reason);
  }
}

/**
 * The bytes `[from, size)` from chunk documents. Committed chunks partition `[0, size)`; an orphan of
 * an interrupted append may overlap them but is always older, so at each position the most recently
 * written chunk covering it wins. A position no chunk covers is a gap: the segment is unreadable now.
 */
function assemble(chunks: readonly Chunk[], from: number, size: number): Uint8Array {
  const out = new Uint8Array(size - from);
  let pos = from;
  while (pos < size) {
    let best: Chunk | undefined;
    for (const c of chunks) {
      if (c.start <= pos && pos < c.end && (!best || c.written > best.written)) best = c;
    }
    if (!best) throw new TransportError("unavailable", "firestore segment has a gap", "protocol");
    const end = Math.min(best.end, size);
    out.set(best.bytes.subarray(pos - best.start, end - best.start), pos - from);
    pos = end;
  }
  return out;
}
