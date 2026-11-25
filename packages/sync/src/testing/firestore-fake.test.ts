import { describe, expect, it } from "vitest";
import { AnonymousAuth } from "../transports/firestore/auth.js";
import {
  bytes,
  FirestoreRest,
  FirestoreRestError,
  type FsValue,
  int,
  readInt,
  str,
} from "../transports/firestore/rest.js";
import { createFakeFirebase, MemoryAuthStore } from "./firestore-fake.js";

const VAULT = "f0".repeat(16);
const ROOT = "projects/demo-cashu/databases/(default)/documents";
const DOCS_URL = `http://fake/v1/${ROOT}`;

function setup(now?: () => number) {
  const fake = createFakeFirebase(now ? { now } : {});
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
    ...(now ? { now } : {}),
  });
  const rest = new FirestoreRest({
    endpoint: fake.endpoint,
    auth,
    fetch: fake.fetch,
    retries: 0,
  });
  return { fake, auth, rest };
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof FirestoreRestError ? e.code : `other:${String(e)}`;
  }
}

const doc = (path: string, fields: Record<string, FsValue>) => ({ update: { name: path, fields } });

describe("fake Firestore commit", () => {
  it("is atomic: one failed precondition (409 ALREADY_EXISTS) applies no write", async () => {
    const { fake, rest } = setup();
    await rest.commit([doc(`vaults/${VAULT}/segments/a`, { size: int(1) })]);
    const before = fake.documents();
    expect(
      await code(
        rest.commit([
          doc(`vaults/${VAULT}/segments/b`, { size: int(2) }),
          {
            update: { name: `vaults/${VAULT}/segments/a`, fields: { size: int(9) } },
            currentDocument: { exists: false },
          },
        ]),
      ),
    ).toBe("aborted");
    expect(fake.documents()).toEqual(before);
  });

  it("checks exists and updateTime preconditions with Firestore's codes", async () => {
    const { fake, rest } = setup();
    const path = `vaults/${VAULT}/segments/a`;
    // exists: true on a missing document is 404 NOT_FOUND.
    expect(await code(rest.commit([{ ...doc(path, {}), currentDocument: { exists: true } }]))).toBe(
      "not-found",
    );
    const { commitTime } = await rest.commit([
      { ...doc(path, { size: int(1) }), currentDocument: { exists: false } },
    ]);
    // exists: false on an existing document is 409 ALREADY_EXISTS (the REST client's "aborted").
    const token = await new AnonymousAuth({
      endpoint: fake.identity,
      store: new MemoryAuthStore(),
      fetch: fake.fetch,
    }).token();
    const res = await fake.fetch(`${DOCS_URL}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        writes: [
          { update: { name: `${ROOT}/${path}`, fields: {} }, currentDocument: { exists: false } },
        ],
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { status: "ALREADY_EXISTS" } });
    // An updateTime mismatch is 400 FAILED_PRECONDITION.
    const stale = { updateTime: "2020-01-01T00:00:00.000000Z" };
    expect(await code(rest.commit([{ ...doc(path, {}), currentDocument: stale }]))).toBe(
      "failed-precondition",
    );
    const next = await rest.commit([
      { ...doc(path, { size: int(2) }), currentDocument: { updateTime: commitTime } },
    ]);
    expect(next.commitTime > commitTime).toBe(true);
    // The old updateTime no longer matches.
    expect(
      await code(rest.commit([{ ...doc(path, {}), currentDocument: { updateTime: commitTime } }])),
    ).toBe("failed-precondition");
  });

  it("merges with updateMask, replaces without it, and deletes", async () => {
    const { fake, rest } = setup();
    const path = `vaults/${VAULT}/segments/a`;
    await rest.commit([doc(path, { size: int(1), device: str("d"), seg: int(0) })]);
    await rest.commit([
      {
        update: { name: path, fields: { size: int(5), extra: str("x") } },
        updateMask: { fieldPaths: ["size", "seg"] },
      },
    ]);
    expect(fake.documents().get(path)?.fields).toEqual({ size: int(5), device: str("d") });
    await rest.commit([doc(path, { only: int(1) })]);
    expect(fake.documents().get(path)?.fields).toEqual({ only: int(1) });
    const { updateTimes } = await rest.commit([
      { delete: path, currentDocument: { exists: true } },
    ]);
    expect(updateTimes).toEqual([undefined]);
    expect(fake.documents().size).toBe(0);
  });

  it("keeps the previous updateTime for a write that changes nothing", async () => {
    const { rest } = setup(() => Date.UTC(2026, 10, 13, 10));
    const path = `vaults/${VAULT}/segments/a`;
    const first = await rest.commit([doc(path, { size: int(1), device: str("d") })]);
    // Same fields in another order: no change, so the old updateTime stays and still matches.
    const same = await rest.commit([
      {
        update: { name: path, fields: { device: str("d"), size: int(1) } },
        currentDocument: { updateTime: first.commitTime },
      },
    ]);
    expect(same.commitTime > first.commitTime).toBe(true);
    expect(same.updateTimes).toEqual([first.commitTime]);
    expect(
      await code(
        rest.commit([
          {
            ...doc(path, { size: int(1), device: str("d") }),
            currentDocument: { updateTime: first.commitTime },
          },
        ]),
      ),
    ).toBeUndefined();
    const changed = await rest.commit([
      {
        ...doc(path, { size: int(2), device: str("d") }),
        currentDocument: { updateTime: first.commitTime },
      },
    ]);
    expect(changed.updateTimes).toEqual([changed.commitTime]);
  });

  it("stamps unique microsecond times per commit, shared by its writes; keeps createTime", async () => {
    const { fake, rest } = setup(() => Date.UTC(2026, 10, 13, 10));
    const a = `vaults/${VAULT}/segments/a`;
    const b = `vaults/${VAULT}/segments/b`;
    const first = await rest.commit([doc(a, {}), doc(b, {})]);
    const second = await rest.commit([doc(a, { size: int(1) })]);
    expect(first.commitTime).toBe("2026-11-13T10:00:00.000000Z");
    expect(second.commitTime).toBe("2026-11-13T10:00:00.000001Z");
    expect(first.updateTimes).toEqual([first.commitTime, first.commitTime]);
    const stored = fake.documents().get(a);
    expect(stored?.createTime).toBe(first.commitTime);
    expect(stored?.updateTime).toBe(second.commitTime);
  });

  it("refuses a document above 1 MiB and a request above 10 MiB", async () => {
    const { fake, rest } = setup();
    const path = `vaults/${VAULT}/c/x`;
    // Name: "vaults" 7 + vault 33 + "c" 2 + "x" 2 + 16 = 60; field "b" 2, raw bytes as-is; + 32.
    const fits = 1_048_576 - 60 - 2 - 32;
    await rest.commit([doc(path, { b: bytes(new Uint8Array(fits)) })]);
    expect(await code(rest.commit([doc(path, { b: bytes(new Uint8Array(fits + 1)) })]))).toBe(
      "invalid-argument",
    );
    const writes = Array.from({ length: 11 }, (_, i) =>
      doc(`vaults/${VAULT}/c/${i}`, { b: bytes(new Uint8Array(800_000)) }),
    );
    // 11 x ~1.07 MB of base64 is above 10 MiB of JSON; 9 of them are below it.
    expect(await code(rest.commit(writes))).toBe("invalid-argument");
    expect(fake.documents().size).toBe(1);
    expect(await code(rest.commit(writes.slice(0, 9)))).toBeUndefined();
    expect(fake.documents().size).toBe(10);
    expect(
      await code(
        rest.commit(Array.from({ length: 501 }, (_, i) => doc(`vaults/${VAULT}/m/${i}`, {}))),
      ),
    ).toBe("invalid-argument");
  });
});

describe("fake Firestore reads", () => {
  it("get answers 404 for a missing document", async () => {
    const { auth, fake } = setup();
    const token = await auth.token();
    const res = await fake.fetch(`${DOCS_URL}/vaults/${VAULT}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { status: "NOT_FOUND" } });
  });

  it("runQuery scopes to one collection under its parent, filters, orders, projects and limits", async () => {
    const { rest } = setup();
    const seg = `vaults/${VAULT}/segments/s`;
    await rest.commit([
      ...[0, 10, 20, 30].map((start) =>
        doc(`${seg}/chunks/${String(start).padStart(12, "0")}`, {
          start: int(start),
          end: int(start + 10),
          tag: str(start % 20 === 0 ? "even" : "odd"),
        }),
      ),
      doc(`vaults/${VAULT}/segments/other/chunks/000000000000`, { start: int(0), end: int(10) }),
      doc(`${seg}/chunks/000000000000/deeper/x`, { start: int(0), end: int(10) }),
      doc(`${seg}/chunks/notanumber`, { start: str("x"), end: str("y") }),
    ]);
    const starts = async (q: Parameters<FirestoreRest["runQuery"]>[1]) =>
      (await rest.runQuery(seg, q)).map((d) => readInt(d.fields.start));

    expect(
      await starts({
        collectionId: "chunks",
        where: [{ field: "end", op: "GREATER_THAN", value: int(15) }],
        orderBy: [{ field: "end" }],
      }),
    ).toEqual([10, 20, 30]);
    expect(
      await starts({
        collectionId: "chunks",
        where: [
          { field: "start", op: "EQUAL", value: int(20) },
          { field: "tag", op: "EQUAL", value: str("even") },
        ],
      }),
    ).toEqual([20]);
    // Queries Firestore serves only with a composite index (none is deployed) are refused.
    for (const q of [
      {
        where: [{ field: "end", op: "GREATER_THAN" as const, value: int(15) }],
        orderBy: [{ field: "start" }],
      },
      {
        where: [
          { field: "end", op: "GREATER_THAN_OR_EQUAL" as const, value: int(20) },
          { field: "tag", op: "EQUAL" as const, value: str("even") },
        ],
      },
      {
        where: [{ field: "tag", op: "EQUAL" as const, value: str("even") }],
        orderBy: [{ field: "start" }],
      },
    ]) {
      expect(await code(rest.runQuery(seg, { collectionId: "chunks", ...q }))).toBe(
        "failed-precondition",
      );
    }
    expect(
      await starts({
        collectionId: "chunks",
        where: [{ field: "start", op: "LESS_THAN", value: int(20) }],
        orderBy: [{ field: "start", direction: "DESCENDING" }],
        limit: 1,
      }),
    ).toEqual([10]);
    const projected = await rest.runQuery(seg, {
      collectionId: "chunks",
      where: [{ field: "start", op: "EQUAL", value: int(0) }],
      select: ["end"],
    });
    expect(projected.map((d) => d.fields)).toEqual([{ end: int(10) }]);
    // `__name__` alone: names without fields; an empty projection: every field.
    const names = await rest.runQuery(seg, { collectionId: "chunks", select: ["__name__"] });
    expect(names).toHaveLength(5);
    expect(names.every((d) => Object.keys(d.fields).length === 0)).toBe(true);
    const all = await rest.runQuery(seg, {
      collectionId: "chunks",
      where: [{ field: "start", op: "EQUAL", value: int(0) }],
      select: [],
    });
    expect(all.map((d) => Object.keys(d.fields).sort())).toEqual([["end", "start", "tag"]]);
    // No filter: every document of the collection, by name.
    expect(
      (await rest.runQuery(seg, { collectionId: "chunks" })).map((d) => d.name.slice(-12)),
    ).toEqual(["000000000000", "000000000010", "000000000020", "000000000030", "s/notanumber"]);
  });

  it("runQuery answers an empty result as one row without a document", async () => {
    const { auth, fake } = setup();
    const res = await fake.fetch(`${DOCS_URL}:runQuery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await auth.token()}` },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "vaults" }] } }),
    });
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("document");
  });

  it("documents() is a snapshot copy filtered by prefix", async () => {
    const { fake, rest } = setup();
    await rest.commit([doc(`vaults/${VAULT}/a/x`, { n: int(1) }), doc(`t_1/${VAULT}`, {})]);
    const snapshot = fake.documents("vaults/");
    expect([...snapshot.keys()]).toEqual([`vaults/${VAULT}/a/x`]);
    (snapshot.get(`vaults/${VAULT}/a/x`)?.fields as Record<string, FsValue>).n = int(2);
    expect(fake.documents().get(`vaults/${VAULT}/a/x`)?.fields.n).toEqual(int(1));
  });
});

describe("fake Firebase authorization and identity", () => {
  it("refuses a missing, malformed, unknown or expired bearer token with 401", async () => {
    let clock = Date.UTC(2026, 10, 13, 10);
    const { auth, fake } = setup(() => clock);
    const token = await auth.token();
    const statusWith = async (headers: Record<string, string>) =>
      (await fake.fetch(`${DOCS_URL}/vaults/${VAULT}`, { method: "GET", headers })).status;
    expect(await statusWith({})).toBe(401);
    expect(await statusWith({ Authorization: token })).toBe(401);
    expect(await statusWith({ Authorization: "Bearer fake-id-token:fake-1:999" })).toBe(401);
    expect(await statusWith({ authorization: `Bearer ${token}` })).toBe(404);
    clock += 3600_000;
    expect(await statusWith({ Authorization: `Bearer ${token}` })).toBe(401);
  });

  it("refuses another project with 403", async () => {
    const { auth, fake } = setup();
    const res = await fake.fetch(
      `http://fake/v1/projects/other/databases/(default)/documents/vaults/${VAULT}`,
      { method: "GET", headers: { Authorization: `Bearer ${await auth.token()}` } },
    );
    expect(res.status).toBe(403);
  });

  it("signs up and refreshes in the documented shapes; expireUser answers TOKEN_EXPIRED", async () => {
    const fake = createFakeFirebase();
    const post = async (url: string, body: string) => {
      const res = await fake.fetch(url, { method: "POST", headers: {}, body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const signUp = await post(
      `${fake.identity.baseUrl}/v1/accounts:signUp?key=${fake.identity.apiKey}`,
      '{"returnSecureToken":true}',
    );
    expect(signUp.body).toMatchObject({
      idToken: "fake-id-token:fake-1:1",
      refreshToken: "fake-refresh:fake-1",
      localId: "fake-1",
      expiresIn: "3600",
    });
    const refreshUrl = `${fake.identity.tokenBaseUrl}/v1/token?key=${fake.identity.apiKey}`;
    const refreshed = await post(
      refreshUrl,
      "grant_type=refresh_token&refresh_token=fake-refresh%3Afake-1",
    );
    expect(refreshed.body).toMatchObject({
      id_token: "fake-id-token:fake-1:2",
      refresh_token: "fake-refresh:fake-1",
      user_id: "fake-1",
      expires_in: "3600",
    });
    fake.expireUser("fake-1");
    const expired = await post(
      refreshUrl,
      "grant_type=refresh_token&refresh_token=fake-refresh%3Afake-1",
    );
    expect(expired).toMatchObject({ status: 400, body: { error: { message: "TOKEN_EXPIRED" } } });
    expect(fake.counters).toMatchObject({ signUp: 1, refresh: 2 });
  });
});

describe("fake Firebase faults", () => {
  it("unavailable and quota fail the next n Firestore requests, then pass", async () => {
    const { fake, auth, rest } = setup();
    await auth.token();
    fake.faults.unavailable(1);
    expect(await code(rest.get(`vaults/${VAULT}`))).toBe("unavailable");
    expect(await code(rest.get(`vaults/${VAULT}`))).toBeUndefined();
    fake.faults.quota(1);
    expect(await code(rest.get(`vaults/${VAULT}`))).toBe("resource-exhausted");
    expect(await code(rest.get(`vaults/${VAULT}`))).toBeUndefined();
    expect(fake.counters.get).toBe(4);
    // Identity requests are not hit by these faults.
    fake.faults.unavailable(1);
    auth.invalidate();
    await auth.token();
    expect(fake.counters.refresh).toBe(1);
    fake.faults.reset();
    expect(await code(rest.get(`vaults/${VAULT}`))).toBeUndefined();
  });

  it("loseNextCommitResponse applies the commit but answers 503", async () => {
    const { fake, rest } = setup();
    fake.faults.loseNextCommitResponse();
    expect(await code(rest.commit([doc(`vaults/${VAULT}/s/a`, { size: int(1) })]))).toBe(
      "unavailable",
    );
    expect(fake.documents().has(`vaults/${VAULT}/s/a`)).toBe(true);
    expect(await code(rest.commit([doc(`vaults/${VAULT}/s/b`, {})]))).toBeUndefined();
  });

  it("reset empties documents, users, counters and faults", async () => {
    const { fake, rest } = setup();
    await rest.commit([doc(`vaults/${VAULT}`, {})]);
    fake.faults.unavailable(5);
    fake.reset();
    expect(fake.documents().size).toBe(0);
    expect(fake.counters).toEqual({
      get: 0,
      runQuery: 0,
      commit: 0,
      delete: 0,
      signUp: 0,
      refresh: 0,
    });
    // The old id token is gone: the client refreshes (refused: user gone) and signs up anew.
    expect(await code(rest.get(`vaults/${VAULT}`))).toBeUndefined();
    expect(fake.counters.signUp).toBe(1);
  });
});
