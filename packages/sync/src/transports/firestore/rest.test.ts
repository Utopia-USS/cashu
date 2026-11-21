import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeFirebase, MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import {
  bytes,
  type FetchInit,
  type FetchLike,
  FirestoreRest,
  FirestoreRestError,
  type FirestoreRestOptions,
  int,
  readBytes,
  readInt,
  readStr,
  str,
  ts,
} from "./rest.js";

const VAULT = "f0".repeat(16);
const SECRETS = /fake-id-token|fake-refresh|Bearer|bytesValue|stringValue|AAEC|vaults\//;

interface Sent {
  readonly url: string;
  readonly init: FetchInit;
}

/** A fetch that answers every request with the next scripted reply (or a network error). */
function scripted(replies: ({ status: number; body?: unknown } | "network")[]): {
  fetch: FetchLike;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const reply = replies.shift() ?? { status: 200, body: {} };
    if (reply === "network") throw new TypeError("fetch failed");
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return { status: reply.status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { fetch, sent };
}

const staticToken = { token: async () => "secret-token" };

function client(fetch: FetchLike, extra: Partial<FirestoreRestOptions> = {}): FirestoreRest {
  return new FirestoreRest({
    endpoint: { projectId: "demo-cashu", baseUrl: "http://127.0.0.1:8080" },
    auth: staticToken,
    fetch,
    sleep: async () => {},
    ...extra,
  });
}

async function failure(p: Promise<unknown>): Promise<FirestoreRestError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FirestoreRestError) return e;
    throw e;
  }
  throw new Error("expected a FirestoreRestError");
}

function fakeClient(extra: Partial<FirestoreRestOptions> = {}) {
  const fake = createFakeFirebase();
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const sleeps: number[] = [];
  const rest = new FirestoreRest({
    endpoint: fake.endpoint,
    auth,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { fake, auth, rest, sleeps };
}

describe("FirestoreRest error mapping", () => {
  const cases: [number, string | undefined, string][] = [
    [400, "FAILED_PRECONDITION", "failed-precondition"],
    [400, "ABORTED", "aborted"],
    [409, "ABORTED", "aborted"],
    [409, "ALREADY_EXISTS", "aborted"],
    [400, "INVALID_ARGUMENT", "invalid-argument"],
    [400, undefined, "invalid-argument"],
    [401, "UNAUTHENTICATED", "unauthenticated"],
    [403, "PERMISSION_DENIED", "permission-denied"],
    [404, "NOT_FOUND", "not-found"],
    [408, undefined, "unavailable"],
    [429, "RESOURCE_EXHAUSTED", "resource-exhausted"],
    [500, "INTERNAL", "unavailable"],
    [502, undefined, "unavailable"],
    [503, "UNAVAILABLE", "unavailable"],
    [504, "DEADLINE_EXCEEDED", "unavailable"],
  ];
  for (const [status, apiStatus, code] of cases) {
    it(`${status} ${apiStatus ?? "(no status)"} -> ${code}`, async () => {
      const body = {
        error: { code: status, status: apiStatus, message: "secret-token bytesValue AAEC" },
      };
      const { fetch, sent } = scripted([{ status, body }]);
      const e = await failure(
        client(fetch, { retries: 0 }).commit([
          { update: { name: `vaults/${VAULT}`, fields: { b: bytes(Uint8Array.of(0, 1, 2)) } } },
        ]),
      );
      expect(e.code).toBe(code);
      expect(e.status).toBe(status);
      expect(e.message).toBe(`firestore ${code} ${status} commit`);
      expect(e.message).not.toMatch(SECRETS);
      expect(sent).toHaveLength(1);
    });
  }

  it("a network error is unavailable with status 0", async () => {
    const { fetch } = scripted(["network"]);
    const e = await failure(client(fetch, { retries: 0 }).get(`vaults/${VAULT}`));
    expect([e.code, e.status, e.message]).toEqual([
      "unavailable",
      0,
      "firestore unavailable 0 get",
    ]);
  });

  it("get answers 404 with undefined, every other verb with not-found", async () => {
    const notFound = { status: 404, body: { error: { status: "NOT_FOUND" } } };
    const { fetch } = scripted([notFound, notFound, notFound]);
    const rest = client(fetch, { retries: 0 });
    expect(await rest.get(`vaults/${VAULT}`)).toBeUndefined();
    expect((await failure(rest.delete(`vaults/${VAULT}`))).code).toBe("not-found");
    expect((await failure(rest.runQuery(`vaults/${VAULT}`, { collectionId: "x" }))).code).toBe(
      "not-found",
    );
  });

  it("an unexpected success body is unavailable, not a crash", async () => {
    const { fetch } = scripted([{ status: 200, body: { nope: 1 } }, { status: 200 }]);
    const rest = client(fetch);
    expect((await failure(rest.commit([]))).code).toBe("unavailable");
    expect((await failure(rest.runQuery("", { collectionId: "x" }))).code).toBe("unavailable");
  });
});

describe("FirestoreRest retries and timeouts", () => {
  it("retries once on 503, then succeeds", async () => {
    const { fake, rest, sleeps } = fakeClient();
    fake.faults.unavailable(1);
    expect(await rest.get(`vaults/${VAULT}`)).toBeUndefined();
    expect(fake.counters.get).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThan(750);
  });

  it("retries once, then throws unavailable", async () => {
    const { fake, rest } = fakeClient();
    fake.faults.unavailable(2);
    const e = await failure(rest.get(`vaults/${VAULT}`));
    expect([e.code, e.status]).toEqual(["unavailable", 503]);
    expect(fake.counters.get).toBe(2);
  });

  it("retries a network error once", async () => {
    const { fetch, sent } = scripted(["network", { status: 200, body: [] }]);
    expect(await client(fetch).runQuery("", { collectionId: "vaults" })).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("429 is retried once, then resource-exhausted", async () => {
    const { fake, rest } = fakeClient();
    fake.faults.quota(1);
    expect(await rest.runQuery("", { collectionId: "vaults" })).toEqual([]);
    fake.faults.quota(2);
    const e = await failure(rest.runQuery("", { collectionId: "vaults" }));
    expect([e.code, e.status]).toEqual(["resource-exhausted", 429]);
    expect(fake.counters.runQuery).toBe(4);
  });

  it("does not retry a 4xx", async () => {
    const { fetch, sent } = scripted([
      { status: 403, body: { error: { status: "PERMISSION_DENIED" } } },
    ]);
    expect((await failure(client(fetch).get(`vaults/${VAULT}`))).code).toBe("permission-denied");
    expect(sent).toHaveLength(1);
  });

  it("times out a slow request (and its retry) as unavailable", async () => {
    const { fake, auth, rest } = fakeClient({ timeoutMs: 20 });
    await auth.token();
    fake.faults.slow(300);
    const e = await failure(rest.get(`vaults/${VAULT}`));
    expect([e.code, e.status, e.message]).toEqual([
      "unavailable",
      0,
      "firestore unavailable 0 get",
    ]);
    expect(fake.counters.get).toBe(2);
  });

  it("timeoutFor adds 1 s per 100 KiB to the base, capped at 120 s, never below the base", () => {
    const rest = client(scripted([]).fetch);
    expect(rest.timeoutFor(0)).toBe(10_000);
    expect(rest.timeoutFor(102_400)).toBe(11_000);
    expect(rest.timeoutFor(8 * 1024 * 1024)).toBe(10_000 + 81_920);
    expect(rest.timeoutFor(50 * 1024 * 1024)).toBe(120_000);
    expect(rest.timeoutFor(-5)).toBe(10_000);
    expect(client(scripted([]).fetch, { timeoutMs: 200_000 }).timeoutFor(1e9)).toBe(200_000);
  });

  it("a timeout wins even when the fetch ignores the abort signal", async () => {
    const hang: FetchLike = () => new Promise(() => {});
    const e = await failure(client(hang, { timeoutMs: 10, retries: 0 }).get(`vaults/${VAULT}`));
    expect(e.code).toBe("unavailable");
  });
});

describe("FirestoreRest payload timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scales a commit's timeout with its body; a per-call timeout replaces it", async () => {
    const { fake, auth, rest } = fakeClient({ timeoutMs: 1_000, retries: 0 });
    await auth.token();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake.faults.slow(5_000);
    // ~1.3 MB of base64: 1 s + ~13 s, so a 5 s round trip lands.
    const big = rest.commit([
      { update: { name: `vaults/${VAULT}/c/a`, fields: { b: bytes(new Uint8Array(1_000_000)) } } },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await big).updateTimes).toHaveLength(1);
    // A small request keeps the 1 s base.
    const small = failure(rest.get(`vaults/${VAULT}/c/a`));
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await small).code).toBe("unavailable");
    // An explicit per-call timeout (a large expected response) is honoured.
    const read = rest.runQuery(`vaults/${VAULT}`, { collectionId: "c" }, { timeoutMs: 6_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toHaveLength(1);
  });
});

describe("FirestoreRest authorization", () => {
  it("sends the bearer token from the token source", async () => {
    const { fetch, sent } = scripted([{ status: 404 }]);
    await client(fetch).get(`vaults/${VAULT}`);
    expect(sent[0]?.init.headers.Authorization).toBe("Bearer secret-token");
  });

  it("a 401 invalidates the token, refreshes it and retries once", async () => {
    const { fake, auth, rest } = fakeClient();
    await auth.token();
    fake.expireIdTokens();
    expect(await rest.get(`vaults/${VAULT}`)).toBeUndefined();
    expect(fake.counters.get).toBe(2);
    expect(fake.counters.refresh).toBe(1);
    expect(fake.counters.signUp).toBe(1);
  });

  it("a second 401 throws unauthenticated", async () => {
    let invalidated = 0;
    const auth = {
      token: async () => "secret-token",
      invalidate: () => {
        invalidated++;
      },
    };
    const reply = { status: 401, body: { error: { status: "UNAUTHENTICATED" } } };
    const { fetch, sent } = scripted([reply, reply, reply]);
    const e = await failure(client(fetch, { auth }).get(`vaults/${VAULT}`));
    expect([e.code, e.status]).toEqual(["unauthenticated", 401]);
    expect(sent).toHaveLength(2);
    expect(invalidated).toBe(1);
  });

  it("a token source without invalidate gets no second attempt", async () => {
    const reply = { status: 401, body: { error: { status: "UNAUTHENTICATED" } } };
    const { fetch, sent } = scripted([reply, reply]);
    expect((await failure(client(fetch).get(`vaults/${VAULT}`))).code).toBe("unauthenticated");
    expect(sent).toHaveLength(1);
  });

  it("a token source that throws a plain error is unauthenticated, value-free", async () => {
    const auth = {
      token: async () => {
        throw new Error("secret-token leaked?");
      },
    };
    const { fetch, sent } = scripted([]);
    const e = await failure(client(fetch, { auth }).get(`vaults/${VAULT}`));
    expect(e.message).toBe("firestore unauthenticated 0 get");
    expect(sent).toHaveLength(0);
  });

  it("a refused token request is unauthenticated, never the database's permission-denied", async () => {
    const thrower = (error: FirestoreRestError) => ({
      token: async () => {
        throw error;
      },
    });
    const { fetch } = scripted([]);
    const refused = await failure(
      client(fetch, {
        auth: thrower(new FirestoreRestError("permission-denied", 403, "refresh")),
      }).get(`vaults/${VAULT}`),
    );
    expect([refused.code, refused.status]).toEqual(["unauthenticated", 403]);
    for (const code of ["unavailable", "resource-exhausted"] as const) {
      const e = await failure(
        client(fetch, { auth: thrower(new FirestoreRestError(code, 0, "refresh")) }).get(
          `vaults/${VAULT}`,
        ),
      );
      expect(e.code).toBe(code);
    }
  });
});

describe("FirestoreRest requests", () => {
  it("builds REST v1 URLs and structured queries", async () => {
    const { fetch, sent } = scripted([
      { status: 200, body: [{ readTime: "2026-11-13T10:00:00.000000Z" }] },
      { status: 200, body: [] },
      { status: 200, body: {} },
    ]);
    const rest = client(fetch);
    await rest.runQuery(`vaults/${VAULT}/segments/a_1`, {
      collectionId: "chunks",
      where: [{ field: "end", op: "GREATER_THAN", value: int(5) }],
      orderBy: [{ field: "start" }],
      select: ["start", "end"],
      limit: 3,
    });
    await rest.runQuery("", {
      collectionId: "vaults",
      where: [
        { field: "a", op: "EQUAL", value: str("x") },
        { field: "b", op: "LESS_THAN", value: int(2) },
      ],
    });
    await rest.delete(`vaults/${VAULT}`, { updateTime: "2026-11-13T10:00:00.000001Z" });
    const docs = "http://127.0.0.1:8080/v1/projects/demo-cashu/databases/(default)/documents";
    expect(sent.map((s) => [s.init.method, s.url])).toEqual([
      ["POST", `${docs}/vaults/${VAULT}/segments/a_1:runQuery`],
      ["POST", `${docs}:runQuery`],
      [
        "DELETE",
        `${docs}/vaults/${VAULT}?currentDocument.updateTime=2026-11-13T10%3A00%3A00.000001Z`,
      ],
    ]);
    expect(JSON.parse(sent[0]?.init.body ?? "")).toEqual({
      structuredQuery: {
        from: [{ collectionId: "chunks" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "end" },
            op: "GREATER_THAN",
            value: { integerValue: "5" },
          },
        },
        orderBy: [{ field: { fieldPath: "start" }, direction: "ASCENDING" }],
        select: { fields: [{ fieldPath: "start" }, { fieldPath: "end" }] },
        limit: 3,
      },
    });
    const composite = JSON.parse(sent[1]?.init.body ?? "") as {
      structuredQuery: { where: { compositeFilter: { op: string; filters: unknown[] } } };
    };
    expect(composite.structuredQuery.where.compositeFilter.op).toBe("AND");
    expect(composite.structuredQuery.where.compositeFilter.filters).toHaveLength(2);
  });

  it("maps full names and relative paths both ways and refuses malformed paths", () => {
    const rest = client(scripted([]).fetch);
    const full = `projects/demo-cashu/databases/(default)/documents/vaults/${VAULT}`;
    expect(rest.fullName(`vaults/${VAULT}`)).toBe(full);
    expect(rest.relativeName(full)).toBe(`vaults/${VAULT}`);
    expect(rest.relativeName(`vaults/${VAULT}`)).toBe(`vaults/${VAULT}`);
    for (const bad of ["vaults//x", "/vaults", "vaults/../x", "vaults/."]) {
      expect(() => rest.fullName(bad)).toThrow("firestore_invalid_id");
    }
    expect(() => rest.relativeName("projects/other/databases/(default)/documents/x/y")).toThrow(
      "firestore_invalid_id",
    );
  });

  it("round-trips commit, get, runQuery and delete against the fake", async () => {
    const { fake, rest } = fakeClient();
    const seg = `vaults/${VAULT}/segments/s1`;
    const { commitTime, updateTimes } = await rest.commit([
      {
        update: { name: seg, fields: { size: int(3), device: str("d") } },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: rest.fullName(`${seg}/chunks/000000000000`),
          fields: { start: int(0), end: int(3), bytes: bytes(Uint8Array.of(7, 8, 9)) },
        },
      },
    ]);
    expect(updateTimes).toEqual([commitTime, commitTime]);
    const meta = await rest.get(seg);
    expect(meta?.name).toBe(rest.fullName(seg));
    expect(meta?.updateTime).toBe(commitTime);
    expect(readInt(meta?.fields.size)).toBe(3);
    expect(readStr(meta?.fields.device)).toBe("d");
    const chunks = await rest.runQuery(seg, {
      collectionId: "chunks",
      where: [{ field: "end", op: "GREATER_THAN", value: int(0) }],
      orderBy: [{ field: "end" }],
    });
    expect(chunks.map((c) => [...readBytes(c.fields.bytes)])).toEqual([[7, 8, 9]]);
    expect(await rest.runQuery(seg, { collectionId: "missing" })).toEqual([]);
    const stale = await failure(rest.delete(seg, { updateTime: "2020-01-01T00:00:00.000000Z" }));
    expect(stale.code).toBe("failed-precondition");
    await rest.delete(seg, { exists: true });
    expect(await rest.get(seg)).toBeUndefined();
    expect([...fake.documents().keys()]).toEqual([`${seg}/chunks/000000000000`]);
  });
});

describe("value helpers", () => {
  it("encode and decode", () => {
    expect(int(42)).toEqual({ integerValue: "42" });
    expect(str("a")).toEqual({ stringValue: "a" });
    expect(ts("2026-11-13T10:00:00Z")).toEqual({ timestampValue: "2026-11-13T10:00:00Z" });
    expect([...readBytes(bytes(Uint8Array.of(0, 255)))]).toEqual([0, 255]);
    expect(() => int(1.5)).toThrow(RangeError);
  });

  it("a missing or mistyped value is a value-free decode error", () => {
    for (const read of [
      () => readInt(undefined),
      () => readInt(str("12")),
      () => readInt({ integerValue: "99999999999999999999" }),
      () => readStr(int(1)),
      () => readBytes(str("AAEC")),
      () => readBytes({ bytesValue: "%%%" }),
    ]) {
      expect(read).toThrow("firestore invalid-argument 0 decode");
    }
  });
});
