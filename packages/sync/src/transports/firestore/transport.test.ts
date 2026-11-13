// FirestoreTransport against the in-memory fake Firebase: layout and id validation, chunking and
// commit sizes, offset conflicts, interrupted appends and orphan chunks, status, error mapping and the
// request counts of the common calls. The contract suite: firestore.contract.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportError } from "../../errors.js";
import { createFakeFirebase, MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import { chunkPath, segmentId, timeKey } from "./layout.js";
import { type FetchLike, type FetchResponse, FirestoreRest } from "./rest.js";
import { FirestoreTransport, type FirestoreTransportOptions } from "./transport.js";

// Synthetic ids.
const VAULT = "0123456789abcdef0123456789abcdef";
const OTHER_VAULT = "fedcba9876543210fedcba9876543210";
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHUNK = 716_800;
const MiB = 1024 * 1024;
/** The import measured in the M4 mining: 64,340 events in one segment. */
const IMPORT_BYTES = 3_228_605;

function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 131 + seed * 7 + (i >> 8)) & 255;
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Byte equality without the matcher's element-wise diff (seconds on megabytes). */
function expectSame(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.findIndex((b, i) => b !== expected[i])).toBe(-1);
}

interface RigOptions {
  readonly retries?: number;
  readonly timeoutMs?: number;
}

/** A delay that honours the abort signal like a real fetch. */
function stall(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

/** One fake Firebase, a fetch that records commits and queries and can refuse, and handles over it. */
function rig(options: RigOptions = {}) {
  const fake = createFakeFirebase();
  const commitBodies: number[] = [];
  /** Writes per commit request. */
  const commitWrites: number[] = [];
  /** HTTP status of every commit response. */
  const commitStatuses: number[] = [];
  /** The structured queries sent, in order. */
  const queries: { select?: { fields?: { fieldPath: string }[] } }[] = [];
  const control = {
    forbidAll: false,
    forbidCommits: false,
    /** When set, the rules in short: a Firestore request by a uid outside it is refused (403). */
    members: undefined as Set<string> | undefined,
    /** Delay every runQuery by this many ms (a slow first pull). */
    slowQueryMs: 0,
    /** Called before the n-th commit (1-based) is forwarded. */
    beforeCommit: undefined as ((n: number) => Promise<void> | void) | undefined,
  };
  const fetch: FetchLike = async (url, init) => {
    const firestore = url.includes("/v1/projects/");
    const commit = firestore && url.endsWith(":commit");
    if (commit) {
      commitBodies.push(init.body?.length ?? 0);
      commitWrites.push((JSON.parse(init.body ?? "{}") as { writes: unknown[] }).writes.length);
      await control.beforeCommit?.(commitBodies.length);
    }
    if (firestore && url.endsWith(":runQuery")) {
      queries.push((JSON.parse(init.body ?? "{}") as { structuredQuery: never }).structuredQuery);
      if (control.slowQueryMs > 0) await stall(control.slowQueryMs, init.signal);
    }
    if (firestore && (control.forbidAll || (commit && control.forbidCommits))) return denied();
    const caller = /^Bearer fake-id-token:([^:]+):/.exec(init.headers.Authorization ?? "")?.[1];
    if (firestore && control.members && !control.members.has(caller ?? "")) return denied();
    const res = await fake.fetch(url, init);
    if (commit) commitStatuses.push(res.status);
    return res;
  };
  const handle = (extra: Partial<FirestoreTransportOptions> = {}) => {
    const auth = new AnonymousAuth({
      endpoint: fake.identity,
      store: new MemoryAuthStore(),
      fetch: fake.fetch,
    });
    const rest = new FirestoreRest({
      endpoint: fake.endpoint,
      auth,
      fetch,
      retries: options.retries ?? 0,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      sleep: async () => {},
    });
    const transport = new FirestoreTransport({ rest, uid: () => auth.uid(), ...extra });
    return { transport, auth, rest };
  };
  const requests = () =>
    fake.counters.get + fake.counters.runQuery + fake.counters.commit + fake.counters.delete;
  const chunkDocs = (vault = VAULT) =>
    [...fake.documents(`vaults/${vault}/segments/`).keys()].filter((k) => k.includes("/chunks/"));
  return {
    fake,
    control,
    commitBodies,
    commitWrites,
    commitStatuses,
    queries,
    handle,
    requests,
    chunkDocs,
  };
}

function denied(): FetchResponse {
  const text = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "x" } });
  return { status: 403, text: async () => text, json: async () => JSON.parse(text) as unknown };
}

/** The rejection of `p`, checked to be a value-free `TransportError` of an allowed code. */
async function failure(p: Promise<unknown>): Promise<TransportError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(TransportError);
  const error = e as TransportError;
  expect(["offset-conflict", "unavailable"]).toContain(error.code);
  expect(error.message).not.toMatch(
    /fake-id-token|fake-refresh|Bearer|[0-9a-f]{32}|[A-Za-z0-9+/=]{24,}|vaults\//,
  );
  return error;
}

describe("layout", () => {
  it("pads segment and chunk ids so they sort and match the rules", () => {
    expect(segmentId(A, 3)).toBe(`${A}_0000000003`);
    expect(chunkPath("vaults/x/segments/y", CHUNK)).toBe("vaults/x/segments/y/chunks/000000716800");
    expect(timeKey("2026-11-13T10:00:00Z") < timeKey("2026-11-13T10:00:00.000001Z")).toBe(true);
    expect(timeKey("2026-11-13T10:00:00.5Z") > timeKey("2026-11-13T10:00:00.400000Z")).toBe(true);
    expect(timeKey("2026-11-13T10:00:00.123Z")).toBe(timeKey("2026-11-13T10:00:00.123000000Z"));
  });

  it("refuses bad vault, device and segment ids before any request", async () => {
    const r = rig();
    const { transport } = r.handle();
    const bytes = pattern(3);
    const bad: Promise<unknown>[] = [
      transport.list("C0FFEE00C0FFEE00C0FFEE00C0FFEE00"),
      transport.list("my-profile"),
      transport.list(`${VAULT}0`),
      transport.read(VAULT, "ABC", 1, 0),
      transport.read(VAULT, A, -1, 0),
      transport.read(VAULT, `${A}/x`, 1, 0),
      transport.append(VAULT, A, 1.5, 0, bytes),
      transport.append(VAULT, A, 10_000_000_000, 0, bytes),
      transport.append("../evil", A, 1, 0, bytes),
      transport.purge("vaults"),
    ];
    for (const p of bad) await expect(p).rejects.toThrow("firestore_invalid_id");
    expect(r.requests()).toBe(0);
    expect(r.fake.counters.signUp).toBe(0);
  });

  it("refuses a bad root and chunk or commit sizes outside the limits", () => {
    const r = rig();
    expect(() => r.handle({ root: "vaults/x" })).toThrow("firestore_invalid_id");
    expect(() => r.handle({ root: "" })).toThrow("firestore_invalid_id");
    expect(() => r.handle({ maxChunkBytes: CHUNK + 1 })).toThrow(RangeError);
    expect(() => r.handle({ maxChunkBytes: 0 })).toThrow(RangeError);
    expect(() => r.handle({ maxChunkBytes: 1000, maxCommitBytes: 999 })).toThrow(RangeError);
    expect(() => r.handle({ maxCommitBytes: 8 * MiB })).toThrow(RangeError);
    for (const maxChunksPerCommit of [0, 10, 1.5]) {
      expect(() => r.handle({ maxChunksPerCommit })).toThrow(RangeError);
    }
  });
});

describe("append and read", () => {
  it("writes one byte as one chunk in one commit", async () => {
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, pattern(1));
    expect(r.fake.counters.commit).toBe(1);
    expect(r.chunkDocs()).toHaveLength(1);
    expect(await transport.list(VAULT)).toEqual([{ device: A, seg: 1, size: 1 }]);
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(1));
  });

  it("splits at exactly 700 KiB", async () => {
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, pattern(CHUNK));
    expect(r.chunkDocs()).toHaveLength(1);
    await transport.append(VAULT, A, 2, 0, pattern(CHUNK + 1, 2));
    expect(r.chunkDocs()).toHaveLength(3);
    const seg2 = [...r.fake.documents(`vaults/${VAULT}/segments/${segmentId(A, 2)}/chunks/`)];
    expect(seg2.map(([, d]) => [d.fields.start, d.fields.end])).toEqual([
      [{ integerValue: "0" }, { integerValue: String(CHUNK) }],
      [{ integerValue: String(CHUNK) }, { integerValue: String(CHUNK + 1) }],
    ]);
    expect(r.fake.counters.commit).toBe(2);
    expectSame(await transport.read(VAULT, A, 1, 0), pattern(CHUNK));
    expectSame(await transport.read(VAULT, A, 2, 0), pattern(CHUNK + 1, 2));
    expectSame(await transport.read(VAULT, A, 2, CHUNK), pattern(CHUNK + 1, 2).slice(CHUNK));
  });

  it("pushes a 3.3 MB import in one commit under 10 MiB, or in several under the chunk or byte cap", async () => {
    const bytes = pattern(IMPORT_BYTES, 3);
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, bytes);
    expect(r.chunkDocs()).toHaveLength(5);
    expect(r.commitWrites).toEqual([6]); // meta + 5 chunks
    expect(Math.max(...r.commitBodies)).toBeLessThanOrEqual(10 * MiB);
    expectSame(await transport.read(VAULT, A, 1, 0), bytes);
    expectSame(await transport.read(VAULT, A, 1, 2_000_000), bytes.slice(2_000_000));

    const small = rig();
    const t = small.handle({ maxCommitBytes: 1.5 * MiB }).transport;
    await t.append(VAULT, A, 1, 0, bytes);
    expect(small.commitWrites).toEqual([3, 3, 2]); // the byte cap: 2 + 2 + 1 chunks
    expect(await t.list(VAULT)).toEqual([{ device: A, seg: 1, size: IMPORT_BYTES }]);
    expectSame(await t.read(VAULT, A, 1, 0), bytes);

    const four = rig();
    await four.handle({ maxChunksPerCommit: 4 }).transport.append(VAULT, A, 1, 0, bytes);
    expect(four.commitWrites).toEqual([5, 2]); // meta + 4 chunks, meta + 1 chunk
    const meta = four.fake.documents().get(`vaults/${VAULT}/segments/${segmentId(A, 1)}`);
    expect(meta?.fields.rev).toEqual({ integerValue: "2" });
  });

  it("keeps the largest commit of a 7 MiB append under the 10 MiB request limit", async () => {
    const r = rig();
    const { transport } = r.handle({ maxCommitBytes: 7 * MiB });
    const bytes = pattern(7 * MiB + 5, 4);
    await transport.append(VAULT, A, 1, 0, bytes);
    expect(r.commitBodies.length).toBeGreaterThan(1);
    expect(Math.max(...r.commitBodies)).toBeLessThanOrEqual(10 * MiB);
    expectSame(await transport.read(VAULT, A, 1, 0), bytes);
  });

  it("grows a segment, reads from any offset, and reads nothing past the end or of an unknown segment", async () => {
    const r = rig();
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    await transport.append(VAULT, A, 1, 0, pattern(5));
    await transport.append(VAULT, A, 1, 5, pattern(7, 2));
    const all = concat(pattern(5), pattern(7, 2));
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(all);
    expect(await transport.read(VAULT, A, 1, -3)).toEqual(all);
    for (const from of [1, 4, 5, 6, 11]) {
      expect(await transport.read(VAULT, A, 1, from)).toEqual(all.slice(from));
    }
    expect(await transport.read(VAULT, A, 1, 12)).toHaveLength(0);
    expect(await transport.read(VAULT, A, 1, 99)).toHaveLength(0);
    expect(await transport.read(VAULT, A, 2, 0)).toHaveLength(0);
    expect(await transport.read(VAULT, B, 1, 0)).toHaveLength(0);
    expect(await transport.read(OTHER_VAULT, A, 1, 0)).toHaveLength(0);
  });

  it("treats an empty append at the current size as a no-op without a write", async () => {
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, new Uint8Array(0));
    expect(r.fake.counters.commit).toBe(0);
    expect(await transport.list(VAULT)).toEqual([]);
    await failure(transport.append(VAULT, A, 1, 3, new Uint8Array(0)));
  });

  it("lists every segment after a rollover, the manifest stream included", async () => {
    const r = rig();
    const a = r.handle().transport;
    const b = r.handle().transport;
    await a.append(VAULT, A, 1, 0, pattern(4));
    await a.append(VAULT, A, 2, 0, pattern(2));
    await a.append(VAULT, A, 0, 0, pattern(1));
    await b.append(VAULT, B, 1, 0, pattern(3));
    const sorted = (await b.list(VAULT)).toSorted((x, y) =>
      x.device === y.device ? x.seg - y.seg : x.device < y.device ? -1 : 1,
    );
    expect(sorted).toEqual([
      { device: A, seg: 0, size: 1 },
      { device: A, seg: 1, size: 4 },
      { device: A, seg: 2, size: 2 },
      { device: B, seg: 1, size: 3 },
    ]);
    expect(await b.list(OTHER_VAULT)).toEqual([]);
  });

  it("keeps the request count of the common calls small", async () => {
    const r = rig();
    const { transport, auth } = r.handle();
    await auth.token();
    const count = async (run: () => Promise<unknown>) => {
      const before = { ...r.fake.counters };
      await run();
      const c = r.fake.counters;
      return {
        get: c.get - before.get,
        runQuery: c.runQuery - before.runQuery,
        commit: c.commit - before.commit,
      };
    };
    expect(await count(() => transport.list(VAULT))).toEqual({ get: 0, runQuery: 1, commit: 0 });
    expect(await count(() => transport.append(VAULT, A, 1, 0, pattern(1024)))).toEqual({
      get: 1,
      runQuery: 0,
      commit: 1,
    });
    const bytes = pattern(IMPORT_BYTES, 5);
    expect(await count(() => transport.append(VAULT, A, 2, 0, bytes))).toEqual({
      get: 1,
      runQuery: 0,
      commit: 1,
    });
    expect(await count(() => transport.read(VAULT, A, 2, 0))).toEqual({
      get: 1,
      runQuery: 1,
      commit: 0,
    });
    expect(await count(() => transport.read(VAULT, A, 2, IMPORT_BYTES))).toEqual({
      get: 1,
      runQuery: 0,
      commit: 0,
    });
    expect(r.fake.counters.signUp).toBe(1);
  });
});

describe("offset conflicts", () => {
  it("refuses an append that is not at the current size and writes nothing", async () => {
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, pattern(3));
    for (const at of [0, 2, 4]) {
      const e = await failure(transport.append(VAULT, A, 1, at, pattern(2, 9)));
      expect(e.code).toBe("offset-conflict");
    }
    expect((await failure(transport.append(VAULT, A, 2, 1, pattern(1)))).code).toBe(
      "offset-conflict",
    );
    expect(await transport.list(VAULT)).toEqual([{ device: A, seg: 1, size: 3 }]);
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(3));
    expect(r.chunkDocs()).toHaveLength(1);
  });

  it("lets exactly one of two writers at the same offset win", async () => {
    const r = rig();
    const one = r.handle().transport;
    const two = r.handle().transport;
    await one.append(VAULT, A, 1, 0, pattern(2));
    const stale = await failure(two.append(VAULT, A, 1, 0, pattern(2, 7)));
    expect(stale.code).toBe("offset-conflict");

    const results = await Promise.allSettled([
      one.append(VAULT, A, 1, 2, pattern(3, 1)),
      two.append(VAULT, A, 1, 2, pattern(3, 2)),
    ]);
    const won = results.findIndex((x) => x.status === "fulfilled");
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = results[1 - won];
    expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(TransportError);
    expect(lost?.status === "rejected" && (lost.reason as TransportError).code).toBe(
      "offset-conflict",
    );
    expect(await one.read(VAULT, A, 1, 0)).toEqual(concat(pattern(2), pattern(3, won + 1)));
  });

  it("maps Firestore's 409 ALREADY_EXISTS on the creating commit to offset-conflict", async () => {
    const r = rig();
    const one = r.handle().transport;
    const two = r.handle().transport;
    r.control.beforeCommit = async (n) => {
      if (n === 1) {
        r.control.beforeCommit = undefined;
        // `one` read no meta (precondition exists: false); `two` creates the segment first.
        await two.append(VAULT, A, 1, 0, pattern(4, 2));
      }
    };
    const e = await failure(one.append(VAULT, A, 1, 0, pattern(3)));
    expect(e.code).toBe("offset-conflict");
    expect(r.commitStatuses).toEqual([200, 409]);
    expect(one.status().lastError).toBeUndefined();
    expect(one.status().lastOk).toBeDefined();
    expect(await one.read(VAULT, A, 1, 0)).toEqual(pattern(4, 2));
  });

  it("keeps two clones apart even when their meta writes would otherwise change nothing", async () => {
    // Same writer uid, same clock: without `rev` an intermediate meta write equals the stored meta,
    // Firestore keeps its updateTime and the other clone's precondition still passes.
    const r = rig();
    const clone = {
      uid: async () => "clone-uid",
      now: () => Date.UTC(2026, 10, 13, 10),
      maxChunkBytes: 4,
      maxCommitBytes: 8,
    };
    const one = r.handle(clone).transport;
    const two = r.handle(clone).transport;
    await one.append(VAULT, A, 1, 0, pattern(4)); // commit 1
    let twoDone: Promise<unknown> | undefined;
    let twoAtCommit = () => {};
    const twoReady = new Promise<void>((resolve) => {
      twoAtCommit = resolve;
    });
    let releaseTwo = () => {};
    const twoGate = new Promise<void>((resolve) => {
      releaseTwo = resolve;
    });
    r.control.beforeCommit = async (n) => {
      if (n === 2) {
        // One's intermediate commit waits until two has read the same meta.
        twoDone = two.append(VAULT, A, 1, 4, pattern(16, 8)).then(
          () => "delivered",
          (e: unknown) => e,
        );
        await twoReady;
      } else if (n === 3) {
        // Two's first commit waits until one's intermediate commit landed.
        twoAtCommit();
        await twoGate;
      } else if (n === 4) {
        // One's final commit waits until two's commit was answered.
        releaseTwo();
        await twoDone;
      }
    };
    await one.append(VAULT, A, 1, 4, pattern(16, 9));
    const outcome = await twoDone;
    expect(outcome).toBeInstanceOf(TransportError);
    expect((outcome as TransportError).code).toBe("offset-conflict");
    expect(await one.read(VAULT, A, 1, 0)).toEqual(concat(pattern(4), pattern(16, 9)));
    const meta = r.fake.documents().get(`vaults/${VAULT}/segments/${segmentId(A, 1)}`);
    expect(meta?.fields.rev).toEqual({ integerValue: "3" });
  });

  it("stops a multi-commit append once another writer committed, and never shows its chunks", async () => {
    const r = rig();
    const slow = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 }).transport;
    const fast = r.handle().transport;
    r.control.beforeCommit = async (n) => {
      if (n === 2) {
        r.control.beforeCommit = undefined;
        // The first commit of `slow` created the meta at size 0; `fast` appends at 0 in between.
        await fast.append(VAULT, A, 1, 0, pattern(6, 5));
      }
    };
    const e = await failure(slow.append(VAULT, A, 1, 0, pattern(20, 4)));
    expect(e.code).toBe("offset-conflict");
    expect(await fast.list(VAULT)).toEqual([{ device: A, seg: 1, size: 6 }]);
    expect(await fast.read(VAULT, A, 1, 0)).toEqual(pattern(6, 5));
  });
});

describe("interrupted appends", () => {
  it("retries a multi-commit append at the same offset after a lost commit response", async () => {
    const r = rig();
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    r.fake.faults.loseNextCommitResponse();
    const e = await failure(transport.append(VAULT, A, 1, 0, pattern(20)));
    expect(e.code).toBe("unavailable");
    expect(await transport.list(VAULT)).toEqual([]);
    expect(await transport.read(VAULT, A, 1, 0)).toHaveLength(0);
    await transport.append(VAULT, A, 1, 0, pattern(20));
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(20));
  });

  it("maps the REST client's own retry of a lost commit to offset-conflict, then succeeds at the same offset", async () => {
    const r = rig({ retries: 1 });
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    r.fake.faults.loseNextCommitResponse();
    const e = await failure(transport.append(VAULT, A, 1, 0, pattern(20)));
    expect(e.code).toBe("offset-conflict");
    await transport.append(VAULT, A, 1, 0, pattern(20));
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(20));
  });

  it("shows a single-commit append whose response was lost, and refuses it a second time", async () => {
    const r = rig();
    const { transport } = r.handle();
    await transport.append(VAULT, A, 1, 0, pattern(3));
    r.fake.faults.loseNextCommitResponse();
    expect((await failure(transport.append(VAULT, A, 1, 3, pattern(4, 2)))).code).toBe(
      "unavailable",
    );
    expect(await transport.list(VAULT)).toEqual([{ device: A, seg: 1, size: 7 }]);
    expect((await failure(transport.append(VAULT, A, 1, 3, pattern(4, 2)))).code).toBe(
      "offset-conflict",
    );
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(concat(pattern(3), pattern(4, 2)));
  });

  it("ignores orphan chunks beyond the committed size", async () => {
    const r = rig();
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    await transport.append(VAULT, A, 1, 0, pattern(10));
    r.fake.faults.loseNextCommitResponse();
    await failure(transport.append(VAULT, A, 1, 10, pattern(30, 2)));
    expect(r.chunkDocs().length).toBeGreaterThan(3); // 3 committed + the orphans of the first commit
    expect(await transport.list(VAULT)).toEqual([{ device: A, seg: 1, size: 10 }]);
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(10));
    expect(await transport.read(VAULT, A, 1, 10)).toHaveLength(0);
  });

  it("reads the committed bytes when older orphans overlap them at other boundaries", async () => {
    const r = rig();
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    // A 20-byte append interrupted at its second commit: chunks 0, 4, 8, 12 written, size still 0.
    r.control.beforeCommit = (n) => {
      if (n === 2) r.fake.faults.loseNextCommitResponse();
    };
    await failure(transport.append(VAULT, A, 1, 0, pattern(20, 1)));
    r.control.beforeCommit = undefined;
    // Shorter retry, then a next append at other boundaries: [0,4) [4,6) [6,10) [10,14) [14,16);
    // the orphans [8,12) and [12,16) stay and overlap.
    await transport.append(VAULT, A, 1, 0, pattern(6, 2));
    await transport.append(VAULT, A, 1, 6, pattern(10, 3));
    const ids = r.chunkDocs().map((k) => Number(k.slice(-12)));
    expect(ids).toEqual([0, 4, 6, 8, 10, 12, 14]);
    const all = concat(pattern(6, 2), pattern(10, 3));
    for (const from of [0, 5, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(await transport.read(VAULT, A, 1, from)).toEqual(all.slice(from));
    }
  });
});

describe("status and errors", () => {
  it("reports unavailable after 503s and records the next success", async () => {
    let now = 1_000;
    const r = rig({ retries: 1 });
    const { transport } = r.handle({ now: () => now });
    r.fake.faults.unavailable(2);
    expect((await failure(transport.list(VAULT))).code).toBe("unavailable");
    expect(transport.status()).toEqual({ lastError: "unavailable", lastErrorAt: 1_000 });
    now = 2_000;
    await transport.list(VAULT);
    expect(transport.status()).toEqual({ lastErrorAt: 1_000, lastOk: 2_000 });
  });

  it("reports quota after 429 RESOURCE_EXHAUSTED", async () => {
    const r = rig({ retries: 1 });
    const { transport } = r.handle();
    r.fake.faults.quota(2);
    expect((await failure(transport.read(VAULT, A, 1, 0))).code).toBe("unavailable");
    expect(transport.status().lastError).toBe("quota");
  });

  it("reports forbidden after 403, never throwing the REST error", async () => {
    const r = rig();
    const { transport } = r.handle();
    r.control.forbidAll = true;
    for (const p of [
      transport.list(VAULT),
      transport.read(VAULT, A, 1, 0),
      transport.append(VAULT, A, 1, 0, pattern(3)),
      transport.purge(VAULT),
    ]) {
      expect((await failure(p)).code).toBe("unavailable");
    }
    expect(transport.status().lastError).toBe("forbidden");
  });

  it("reports a lost relay identity when the uid changed, and clears it after the next success", async () => {
    const r = rig();
    let uid = "uid-one";
    const { transport } = r.handle({ uid: async () => uid });
    await transport.append(VAULT, A, 1, 0, pattern(3));
    uid = "uid-two";
    r.control.forbidCommits = true;
    expect((await failure(transport.append(VAULT, A, 1, 3, pattern(3)))).code).toBe("unavailable");
    expect(transport.status().lastError).toBe("relay-identity-lost");
    // The Mac granted uid-two: the next call succeeds, a later failure is no longer labelled lost.
    r.control.forbidCommits = false;
    await transport.append(VAULT, A, 1, 3, pattern(3));
    expect(transport.status().lastError).toBeUndefined();
    r.fake.faults.unavailable(1);
    await failure(transport.list(VAULT));
    expect(transport.status().lastError).toBe("unavailable");
  });

  it("reports a lost identity on every call path once the anonymous user was replaced", async () => {
    const r = rig();
    const { transport, auth } = r.handle();
    const first = await auth.uid();
    const members = new Set([first]);
    r.control.members = members;
    await transport.append(VAULT, A, 1, 0, pattern(3));
    r.fake.expireUser(first);
    r.fake.expireIdTokens();
    // 401, the refresh is refused for good, a new anonymous user is signed up and refused (403).
    expect((await failure(transport.list(VAULT))).code).toBe("unavailable");
    expect(transport.status().lastError).toBe("relay-identity-lost");
    const second = await auth.uid();
    expect(second).not.toBe(first);
    for (const call of [
      () => transport.read(VAULT, A, 1, 0),
      () => transport.append(VAULT, A, 1, 3, pattern(2)),
      () => transport.purge(VAULT),
      () => transport.list(VAULT),
    ]) {
      expect((await failure(call())).code).toBe("unavailable");
      expect(transport.status().lastError).toBe("relay-identity-lost");
    }
    // Membership granted again: the label clears with the first success.
    members.add(second);
    expect(await transport.read(VAULT, A, 1, 0)).toEqual(pattern(3));
    expect(transport.status().lastError).toBeUndefined();
  });

  it("a refusal without an earlier success is forbidden, not a lost identity", async () => {
    const r = rig();
    const { transport } = r.handle();
    r.control.members = new Set();
    await failure(transport.list(VAULT));
    expect(transport.status().lastError).toBe("forbidden");
  });

  it("times out a slow relay as unavailable", async () => {
    const r = rig({ timeoutMs: 20 });
    const { transport, auth } = r.handle();
    await auth.token();
    r.fake.faults.slow(200);
    expect((await failure(transport.list(VAULT))).code).toBe("unavailable");
    expect(transport.status().lastError).toBe("unavailable");
  });

  it("refuses an unreadable meta and a segment with a gap as unavailable", async () => {
    const r = rig();
    const { transport, rest } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    await transport.append(VAULT, A, 1, 0, pattern(12));
    const segment = `vaults/${VAULT}/segments/${segmentId(A, 1)}`;
    await rest.delete(chunkPath(segment, 4));
    expect((await failure(transport.read(VAULT, A, 1, 0))).message).toBe(
      "firestore segment has a gap",
    );
    expect(await transport.read(VAULT, A, 1, 8)).toEqual(pattern(12).slice(8));
    await rest.commit([{ update: { name: segment, fields: { size: { stringValue: "x" } } } }]);
    expect((await failure(transport.read(VAULT, A, 1, 0))).code).toBe("unavailable");
    expect((await failure(transport.append(VAULT, A, 1, 12, pattern(1)))).code).toBe("unavailable");
    expect(await transport.list(VAULT)).toEqual([]);
  });
});

describe("payload timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a large chunk read time in proportion to its size, a small one the base", async () => {
    const r = rig({ timeoutMs: 1_000 });
    const { transport } = r.handle();
    const bytes = pattern(IMPORT_BYTES, 6);
    await transport.append(VAULT, A, 1, 0, bytes);
    await transport.append(VAULT, B, 1, 0, pattern(3));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    r.control.slowQueryMs = 30_000;
    // 3.3 MB as base64 is ~4.3 MB: 1 s base + ~42 s, so a 30 s pull finishes.
    const big = transport.read(VAULT, A, 1, 0);
    await vi.advanceTimersByTimeAsync(30_000);
    expectSame(await big, bytes);
    // Three bytes keep the 1 s base: the same pull times out.
    const small = failure(transport.read(VAULT, B, 1, 0));
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await small).code).toBe("unavailable");
    expect(transport.status().lastError).toBe("unavailable");
  });
});

describe("purge", () => {
  it("deletes every segment and chunk document of the vault and nothing else", async () => {
    const r = rig();
    const { transport } = r.handle({ maxChunkBytes: 4, maxCommitBytes: 8 });
    await transport.append(VAULT, A, 1, 0, pattern(10));
    await transport.append(VAULT, B, 2, 0, pattern(5));
    await transport.append(OTHER_VAULT, A, 1, 0, pattern(3));
    await transport.purge(VAULT);
    expect([...r.fake.documents(`vaults/${VAULT}/`).keys()]).toEqual([]);
    expect(await transport.list(VAULT)).toEqual([]);
    expect(await transport.list(OTHER_VAULT)).toEqual([{ device: A, seg: 1, size: 3 }]);
    expect(await transport.read(OTHER_VAULT, A, 1, 0)).toEqual(pattern(3));
  });

  it("never deletes the vault or member documents, asks for names only, at most 100 deletes per commit", async () => {
    const r = rig();
    const { transport, rest } = r.handle({
      maxChunkBytes: 4,
      maxCommitBytes: 36,
      maxChunksPerCommit: 9,
    });
    await transport.append(VAULT, A, 1, 0, pattern(600)); // 150 chunks
    await transport.append(VAULT, A, 2, 0, pattern(8)); // 2 chunks
    await transport.append(VAULT, B, 1, 0, pattern(4)); // 1 chunk
    const vaultDoc = `vaults/${VAULT}`;
    const memberDoc = `vaults/${VAULT}/members/uid-x`;
    await rest.commit([
      { update: { name: vaultDoc, fields: { admins: { arrayValue: {} } } } },
      { update: { name: memberDoc, fields: { device: { stringValue: A } } } },
    ]);
    r.commitWrites.length = 0;
    r.queries.length = 0;
    await transport.purge(VAULT);
    // Segment A_1: 100 chunks, then its last 50 + meta with A_2 (2 + meta) and B_1 (1 + meta).
    expect(r.commitWrites).toEqual([100, 56]);
    expect(r.queries).toHaveLength(4);
    for (const q of r.queries) expect(q.select?.fields).toEqual([{ fieldPath: "__name__" }]);
    expect([...r.fake.documents(vaultDoc).keys()]).toEqual([vaultDoc, memberDoc]);
  });
});
