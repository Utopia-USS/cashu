import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  answerChallenge,
  answerHello,
  checkAuth,
  formatNonce,
  formatToken,
  type HostIdentity,
  makeHello,
  parseToken,
  proofsEqual,
  readAuthReply,
} from "./handshake.js";
import { type ClientFrame, clientFrameSchema, REFUSAL_MESSAGES } from "./messages.js";
import { roleAllows } from "./roles.js";
import { HOST_PROTOCOL } from "./version.js";

const nonce = () => formatNonce(randomBytes(32));
const DATA_DIR = "a".repeat(64);
const token = new Uint8Array(randomBytes(32));

const host = (over: Partial<HostIdentity> = {}): HostIdentity => ({
  token,
  dataDir: DATA_DIR,
  protocol: HOST_PROTOCOL,
  build: "test-build",
  features: ["store.v2"],
  stopping: false,
  ...over,
});

const hello = (over: Partial<Parameters<typeof makeHello>[0]> = {}) =>
  makeHello({
    role: "cli",
    dataDir: DATA_DIR,
    build: "client",
    nc: nonce(),
    protocol: HOST_PROTOCOL,
    ...over,
  });

function run(clientToken: Uint8Array, h = hello()) {
  const outcome = answerHello(h, host(), nonce());
  if (!outcome.ok) throw new Error("refused");
  return { h, outcome, step: answerChallenge(outcome.reply, h, clientToken) };
}

describe("handshake", () => {
  it("matches verified packaged content builds for writers while retaining cross-build admin", () => {
    const first = `desktop-1.2.3-${"a".repeat(64)}`;
    const second = `desktop-1.2.3-${"b".repeat(64)}`;
    expect(HOST_PROTOCOL.minor).toBe(8);
    for (const role of ["ui", "cli", "mcp"] as const) {
      const h = hello({ role, ...(role === "mcp" ? { profile: "demo-anna" } : {}), build: first });
      const accepted = answerHello(h, host({ build: first }), nonce());
      expect(accepted.ok).toBe(true);
      const rejected = answerHello(h, host({ build: second }), nonce());
      expect(rejected).toMatchObject({ ok: false, reply: { reason: "build" } });
      if (accepted.ok) {
        expect(answerChallenge({ ...accepted.reply, build: second }, h, token)).toEqual({
          kind: "refused",
          reason: "build",
        });
      }
    }
    const admin = hello({ role: "admin", build: first });
    expect(answerHello(admin, host({ build: second }), nonce()).ok).toBe(true);
    expect(answerHello(hello(), host(), nonce()).ok).toBe(true);
  });
  it("authenticates both sides and binds role and profile", () => {
    const h = hello({ role: "mcp", profile: "demo-anna" });
    const { outcome, step } = run(token, h);
    expect(step.kind).toBe("auth");
    if (step.kind !== "auth" || !outcome.ok) return;
    expect(step.host).toEqual({
      protocol: HOST_PROTOCOL,
      build: "test-build",
      features: ["store.v2"],
    });
    const auth = checkAuth(step.reply, outcome.pending, token);
    expect(auth).toEqual({
      ok: true,
      session: { role: "mcp", profile: "demo-anna", build: "client", protocol: HOST_PROTOCOL },
    });
    expect(readAuthReply({ t: "ready" })).toEqual({ kind: "ready" });
  });

  it("a client with the wrong token rejects the host before sending any proof", () => {
    const { step } = run(new Uint8Array(randomBytes(32)));
    expect(step).toEqual({ kind: "unverified" });
  });

  it("refuses a client proof made with the wrong token, or for another role", () => {
    const h = hello();
    const outcome = answerHello(h, host(), nonce());
    if (!outcome.ok) throw new Error("refused");
    const forged = answerChallenge(outcome.reply, h, token);
    if (forged.kind !== "auth") throw new Error("no auth");
    // The same proof replayed under another role does not verify.
    const asAdmin = {
      ...outcome.pending,
      hello: { ...outcome.pending.hello, role: "admin" as const },
    };
    expect(checkAuth(forged.reply, asAdmin, token)).toMatchObject({
      ok: false,
      reply: { reason: "auth" },
    });
    expect(checkAuth({ t: "auth", proof: "0".repeat(64) }, outcome.pending, token)).toMatchObject({
      ok: false,
      reply: { reason: "auth" },
    });
    expect(checkAuth({ t: "auth" }, outcome.pending, token)).toMatchObject({
      reply: { reason: "invalid" },
    });
  });

  it("refuses another data dir, another major, a stopping or starting host and a role without its profile", () => {
    const refusedFor = (raw: unknown, over: Partial<HostIdentity> = {}) => {
      const o = answerHello(raw, host(over), nonce());
      return o.ok ? "accepted" : o.reply.reason;
    };
    expect(refusedFor(hello({ dataDir: "b".repeat(64) }))).toBe("data-dir");
    // Another major is refused even when the rest of its hello is unreadable.
    expect(refusedFor({ t: "hello", protocol: { major: 2, minor: 0 }, whatever: true })).toBe(
      "protocol",
    );
    expect(refusedFor({ ...hello(), protocol: { major: 0, minor: 9 } })).toBe("protocol");
    expect(refusedFor({ ...hello(), protocol: { major: 1, minor: 7 } })).toBe("accepted");
    expect(refusedFor(hello(), { stopping: true })).toBe("stopping");
    expect(refusedFor(hello(), { starting: true })).toBe("starting");
    expect(refusedFor(hello(), { starting: true, stopping: true })).toBe("stopping");
    expect(refusedFor({ ...hello(), role: "mcp" })).toBe("role");
    expect(refusedFor({ ...hello(), profile: "demo-anna" })).toBe("role");
    expect(refusedFor({ t: "auth" })).toBe("invalid");
    expect(refusedFor({ ...hello(), nc: "short" })).toBe("invalid");
    const o = answerHello(hello({ dataDir: "b".repeat(64) }), host(), nonce());
    expect(o.ok ? undefined : o.reply.message).toBe(REFUSAL_MESSAGES["data-dir"]);
  });

  it("a client refuses a host of another major after verifying it", () => {
    const h = hello();
    const outcome = answerHello(h, host(), nonce());
    if (!outcome.ok) throw new Error("refused");
    // A host that answered a hello of another major (it should not) is still refused by the client.
    const reply = { ...outcome.reply, protocol: { major: 2, minor: 0 } };
    expect(answerChallenge(reply, h, token)).toEqual({ kind: "refused", reason: "protocol" });
    expect(answerChallenge({ t: "refused", reason: "stopping", message: "x" }, h, token)).toEqual({
      kind: "refused",
      reason: "stopping",
    });
    expect(answerChallenge({ t: "nope" }, h, token)).toEqual({ kind: "invalid" });
  });

  it("parses token files and compares proofs", () => {
    const text = formatToken(token);
    expect(parseToken(`${text}\n`)).toEqual(token);
    expect(parseToken("zz")).toBeUndefined();
    expect(() => formatToken(new Uint8Array(3))).toThrow(RangeError);
    expect(proofsEqual("ab", "ab")).toBe(true);
    expect(proofsEqual("ab", "ac")).toBe(false);
    expect(proofsEqual("ab", "abc")).toBe(false);
  });
});

describe("roles", () => {
  const frames: Record<string, ClientFrame> = {
    store: { t: "store", m: { t: "unsub", sid: 1 } },
    mcp: { t: "mcp", line: "{}" },
    mcpOpen: { t: "req", id: 1, method: "mcp.open", params: {} },
    cliExec: { t: "req", id: 1, method: "cli.exec", params: {} },
    adminStatus: { t: "req", id: 1, method: "admin.status", params: {} },
    cancel: { t: "cancel", id: 1 },
  };
  const allowed = (role: Parameters<typeof roleAllows>[0]) =>
    Object.entries(frames)
      .filter(([, f]) => roleAllows(role, clientFrameSchema.parse(f)))
      .map(([k]) => k);

  it("binds each role to its frames", () => {
    expect(allowed("ui")).toEqual(["store"]);
    expect(allowed("mcp")).toEqual(["mcp", "mcpOpen", "cancel"]);
    expect(allowed("cli")).toEqual(["cliExec", "cancel"]);
    expect(allowed("admin")).toEqual(["adminStatus", "cancel"]);
  });

  it("refuses malformed session frames", () => {
    expect(
      clientFrameSchema.safeParse({ t: "req", id: 1, method: "Status", params: {} }).success,
    ).toBe(false);
    expect(clientFrameSchema.safeParse({ t: "mcp", line: "a\nb" }).success).toBe(false);
    expect(
      clientFrameSchema.safeParse({ t: "req", id: -1, method: "a.b", params: {} }).success,
    ).toBe(false);
  });
});
