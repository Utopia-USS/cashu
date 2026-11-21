import { describe, expect, it } from "vitest";
import { createFakeFirebase, MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth, type AnonymousAuthOptions, type AuthRecord } from "./auth.js";
import { type FetchInit, type FetchLike, FirestoreRestError } from "./rest.js";

const MINUTE = 60_000;
const SECRETS = /fake-id-token|fake-refresh|refresh_token|secret|Bearer/;

class CountingStore extends MemoryAuthStore {
  saves = 0;
  clears = 0;
  override save(record: AuthRecord): void {
    this.saves++;
    super.save(record);
  }
  override clear(): void {
    this.clears++;
    super.clear();
  }
}

function setup(extra: Partial<AnonymousAuthOptions> = {}) {
  const fake = createFakeFirebase();
  let clock = Date.UTC(2026, 10, 13, 10);
  const store = new CountingStore();
  const lost: string[] = [];
  const options: AnonymousAuthOptions = {
    endpoint: fake.identity,
    store,
    fetch: fake.fetch,
    now: () => clock,
    onIdentityLost: (uid) => lost.push(uid),
    ...extra,
  };
  return {
    fake,
    store,
    lost,
    options,
    auth: new AnonymousAuth(options),
    advance: (ms: number) => {
      clock += ms;
    },
  };
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

function scripted(replies: ({ status: number; body?: unknown } | "network")[]): {
  fetch: FetchLike;
  sent: { url: string; init: FetchInit }[];
} {
  const sent: { url: string; init: FetchInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const reply = replies.shift() ?? "network";
    if (reply === "network") throw new TypeError("fetch failed");
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return { status: reply.status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { fetch, sent };
}

describe("AnonymousAuth", () => {
  it("signs up once, saves the record and caches the token", async () => {
    const { fake, store, auth } = setup();
    const token = await auth.token();
    expect(token).toBe("fake-id-token:fake-1:1");
    expect(await auth.uid()).toBe("fake-1");
    expect(await auth.token()).toBe(token);
    expect(fake.counters).toMatchObject({ signUp: 1, refresh: 0 });
    expect(store.record).toEqual({ uid: "fake-1", refreshToken: "fake-refresh:fake-1" });
    expect(store.saves).toBe(1);
  });

  it("refreshes the token once it is 50 minutes old, keeping the uid", async () => {
    const { fake, store, auth, advance } = setup();
    const first = await auth.token();
    advance(49 * MINUTE);
    expect(await auth.token()).toBe(first);
    advance(MINUTE);
    const second = await auth.token();
    expect(second).not.toBe(first);
    expect(await auth.uid()).toBe("fake-1");
    expect(fake.counters).toMatchObject({ signUp: 1, refresh: 1 });
    expect(store.saves).toBe(1);
  });

  it("refreshes earlier when the server grants a shorter lifetime", async () => {
    const { fetch } = scripted([
      { status: 200, body: { idToken: "t1", refreshToken: "r", localId: "u", expiresIn: "600" } },
      {
        status: 200,
        body: { id_token: "t2", refresh_token: "r", user_id: "u", expires_in: "600" },
      },
    ]);
    const { auth, advance } = setup({ fetch });
    expect(await auth.token()).toBe("t1");
    // 600 s granted: refreshed at 5/6 of it (500 s), not at 50 minutes.
    advance(8 * MINUTE);
    expect(await auth.token()).toBe("t1");
    advance(MINUTE);
    expect(await auth.token()).toBe("t2");
  });

  it("a new instance over a stored record refreshes instead of signing up", async () => {
    const { fake, options, auth } = setup();
    await auth.token();
    const again = new AnonymousAuth(options);
    expect(await again.uid()).toBe("fake-1");
    expect(fake.counters).toMatchObject({ signUp: 1, refresh: 1 });
  });

  it("saves a rotated refresh token", async () => {
    const { fetch } = scripted([
      {
        status: 200,
        body: { id_token: "t", refresh_token: "r2", user_id: "u", expires_in: "3600" },
      },
    ]);
    const store = new CountingStore({ uid: "u", refreshToken: "r1" });
    const auth = new AnonymousAuth({ endpoint: { apiKey: "k" }, store, fetch });
    expect(await auth.token()).toBe("t");
    expect(store.record).toEqual({ uid: "u", refreshToken: "r2" });
  });

  it("invalidate drops the cached token: the next call refreshes", async () => {
    const { fake, auth } = setup();
    const first = await auth.token();
    auth.invalidate();
    expect(await auth.token()).not.toBe(first);
    expect(fake.counters.refresh).toBe(1);
  });

  it("identity lost (TOKEN_EXPIRED): clears the store, reports the old uid, signs up anew", async () => {
    const { fake, store, lost, auth } = setup();
    await auth.token();
    fake.expireUser("fake-1");
    auth.invalidate();
    expect(await auth.uid()).toBe("fake-2");
    expect(lost).toEqual(["fake-1"]);
    expect(store.clears).toBe(1);
    expect(store.record).toEqual({ uid: "fake-2", refreshToken: "fake-refresh:fake-2" });
    expect(fake.counters).toMatchObject({ signUp: 2, refresh: 1 });
  });

  it("a throwing onIdentityLost listener still gets the new identity signed up", async () => {
    const { fake, store, auth } = setup({
      onIdentityLost: () => {
        throw new Error("listener failed");
      },
    });
    await auth.token();
    fake.expireUser("fake-1");
    auth.invalidate();
    expect(await auth.uid()).toBe("fake-2");
    expect(store.record?.uid).toBe("fake-2");
  });

  for (const message of [
    "USER_NOT_FOUND",
    "INVALID_REFRESH_TOKEN",
    "USER_DISABLED",
    "TOKEN_EXPIRED : detail",
  ]) {
    it(`identity lost on ${message}`, async () => {
      const { fetch } = scripted([
        { status: 400, body: { error: { code: 400, message, status: "INVALID_ARGUMENT" } } },
        {
          status: 200,
          body: { idToken: "t", refreshToken: "r2", localId: "u2", expiresIn: "3600" },
        },
      ]);
      const store = new CountingStore({ uid: "u1", refreshToken: "r1" });
      const lost: string[] = [];
      const auth = new AnonymousAuth({
        endpoint: { apiKey: "k" },
        store,
        fetch,
        onIdentityLost: (uid) => lost.push(uid),
      });
      expect(await auth.uid()).toBe("u2");
      expect(lost).toEqual(["u1"]);
      expect(store.record).toEqual({ uid: "u2", refreshToken: "r2" });
    });
  }

  it("an unknown stored refresh token in the fake is identity lost too", async () => {
    const { fake, options } = setup();
    const store = new CountingStore({ uid: "fake-9", refreshToken: "garbage" });
    const lost: string[] = [];
    const auth = new AnonymousAuth({ ...options, store, onIdentityLost: (uid) => lost.push(uid) });
    expect(await auth.uid()).toBe("fake-1");
    expect(lost).toEqual(["fake-9"]);
    expect(fake.counters).toMatchObject({ signUp: 1, refresh: 1 });
  });

  it("another refresh failure keeps the identity and throws by HTTP code", async () => {
    const replies: [number, string, string][] = [
      [503, "UNAVAILABLE", "unavailable"],
      [429, "RESOURCE_EXHAUSTED", "resource-exhausted"],
      [403, "PERMISSION_DENIED", "permission-denied"],
      [400, "INVALID_ARGUMENT", "invalid-argument"],
    ];
    for (const [status, apiStatus, code] of replies) {
      const { fetch } = scripted([
        {
          status,
          body: { error: { code: status, message: "secret refresh_token", status: apiStatus } },
        },
      ]);
      const store = new CountingStore({ uid: "u1", refreshToken: "secret-r1" });
      const auth = new AnonymousAuth({ endpoint: { apiKey: "k" }, store, fetch });
      const e = await failure(auth.token());
      expect([e.code, e.status, e.message]).toEqual([
        code,
        status,
        `firestore ${code} ${status} refresh`,
      ]);
      expect(e.message).not.toMatch(SECRETS);
      expect(store.clears).toBe(0);
    }
  });

  it("a network failure or a malformed answer is unavailable, value-free", async () => {
    const network = new AnonymousAuth({
      endpoint: { apiKey: "k" },
      store: new MemoryAuthStore(),
      fetch: scripted(["network"]).fetch,
    });
    const e = await failure(network.token());
    expect([e.code, e.status, e.message]).toEqual([
      "unavailable",
      0,
      "firestore unavailable 0 signUp",
    ]);
    const malformed = new AnonymousAuth({
      endpoint: { apiKey: "k" },
      store: new MemoryAuthStore(),
      fetch: scripted([{ status: 200, body: { idToken: "secret" } }]).fetch,
    });
    const m = await failure(malformed.token());
    expect(m.code).toBe("unavailable");
    expect(m.message).not.toMatch(SECRETS);
  });

  it("a failed attempt is not cached: the next call tries again", async () => {
    const { fetch } = scripted([
      "network",
      { status: 200, body: { idToken: "t", refreshToken: "r", localId: "u", expiresIn: "3600" } },
    ]);
    const auth = new AnonymousAuth({
      endpoint: { apiKey: "k" },
      store: new MemoryAuthStore(),
      fetch,
    });
    await failure(auth.token());
    expect(await auth.token()).toBe("t");
  });

  it("times out a slow identity server as unavailable", async () => {
    const { fake, auth } = setup({ timeoutMs: 20 });
    fake.faults.slow(300);
    const e = await failure(auth.token());
    expect([e.code, e.status]).toEqual(["unavailable", 0]);
  });

  it("concurrent callers share one sign-up and one refresh", async () => {
    const { fake, auth, advance } = setup();
    const tokens = await Promise.all([auth.token(), auth.token(), auth.uid(), auth.token()]);
    expect(new Set(tokens).size).toBe(2);
    expect(fake.counters.signUp).toBe(1);
    advance(50 * MINUTE);
    const refreshed = await Promise.all([auth.token(), auth.token(), auth.token()]);
    expect(new Set(refreshed).size).toBe(1);
    expect(fake.counters.refresh).toBe(1);
  });

  it("sends the documented wire requests (emulator URLs, form-encoded refresh)", async () => {
    const { fetch, sent } = scripted([
      {
        status: 200,
        body: { idToken: "t", refreshToken: "r/+=", localId: "u", expiresIn: "3600" },
      },
      {
        status: 200,
        body: { id_token: "t2", refresh_token: "r/+=", user_id: "u", expires_in: "3600" },
      },
    ]);
    const auth = new AnonymousAuth({
      endpoint: {
        apiKey: "demo-key",
        baseUrl: "http://127.0.0.1:9099/identitytoolkit.googleapis.com",
        tokenBaseUrl: "http://127.0.0.1:9099/securetoken.googleapis.com",
      },
      store: new MemoryAuthStore(),
      fetch,
    });
    await auth.token();
    auth.invalidate();
    await auth.token();
    expect(
      sent.map((s) => [s.init.method, s.url, s.init.headers["Content-Type"], s.init.body]),
    ).toEqual([
      [
        "POST",
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key",
        "application/json",
        '{"returnSecureToken":true}',
      ],
      [
        "POST",
        "http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=demo-key",
        "application/x-www-form-urlencoded",
        "grant_type=refresh_token&refresh_token=r%2F%2B%3D",
      ],
    ]);
  });

  it("defaults to the production identity hosts", async () => {
    const { fetch, sent } = scripted([
      { status: 200, body: { idToken: "t", refreshToken: "r", localId: "u", expiresIn: "3600" } },
    ]);
    await new AnonymousAuth({
      endpoint: { apiKey: "k" },
      store: new MemoryAuthStore(),
      fetch,
    }).token();
    expect(sent[0]?.url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=k");
  });
});
