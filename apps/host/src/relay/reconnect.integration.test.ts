// The relay recovery secret on the Mac host: created at enable and kept only in the (synthetic)
// keychain before the commit that writes its hash, spent by `native.relay.reconnect` after an identity
// loss (new uid admin again under a NEW secret, the lost uids' memberships removed, passes resumed),
// refused `no_recovery_secret` without one, and crash-safe at every step. The fake runs no rules: the
// fetch below adds the membership check and the recovery branch of firestore.rules in short.
// Synthetic vault, demo-cashu fake only.
import { createHash } from "node:crypto";
import type { RelayRecoveryRecord, RelayRecoverySecrets } from "@cashu/node-host/relay-auth";
import { relaySetting } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { FakeFirebase } from "@cashu/sync/testing";
import { afterEach, expect, it } from "vitest";
import type { LocalHost } from "../host.js";
import {
  enabledRelayHost,
  membersOnlyFetch,
  type RelayHostEnv,
  relayBytes,
  relayHarness,
  renameVault,
  until,
  vaultQueueDrained,
} from "../testing/relayFixture.js";
import { RELAY_BACKOFF_MAX_MS, RELAY_PUSH_DEBOUNCE_MS } from "./policy.js";

const harness = relayHarness();
afterEach(() => harness.cleanup());

/** A synthetic keychain of recovery secrets; `onSet` sees every write before it lands. */
class MemoryRecoverySecrets implements RelayRecoverySecrets {
  readonly records = new Map<string, RelayRecoveryRecord>();
  onSet: (vault: string, record: RelayRecoveryRecord) => void = () => {};

  async get(vault: string) {
    const record = this.records.get(vault);
    return record === undefined ? null : copy(record);
  }

  async set(vault: string, record: RelayRecoveryRecord) {
    this.onSet(vault, record);
    this.records.set(vault, copy(record));
  }

  async clear(vault: string) {
    this.records.delete(vault);
  }
}

function copy(record: RelayRecoveryRecord): RelayRecoveryRecord {
  return record.next === undefined
    ? { current: record.current.slice() }
    : { current: record.current.slice(), next: record.next.slice() };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const sha256b64 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64");

type Write = {
  readonly update?: {
    readonly name: string;
    readonly fields: Record<string, { bytesValue?: string }>;
  };
};

/**
 * membersOnlyFetch plus the rules' recovery branch: a commit that writes `recoveries/{caller}` passes
 * only when no proof doc of that uid exists, sha256(proof) is the vault's current `recoveryHash` and
 * the same commit replaces that hash. Every other request is judged by membership.
 */
function recoveryRulesFetch(fake: FakeFirebase): FakeFirebase["fetch"] {
  const members = membersOnlyFetch(fake);
  const deny = () => {
    const text = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } });
    return { status: 403, text: async () => text, json: async () => JSON.parse(text) };
  };
  return async (url, init) => {
    if (url.endsWith(":commit")) {
      const writes = (JSON.parse(init.body ?? "{}") as { writes?: Write[] }).writes ?? [];
      const caller = /^Bearer fake-id-token:([^:]+):/.exec(init.headers.Authorization ?? "")?.[1];
      for (const write of writes) {
        const proofDoc = /documents\/vaults\/([0-9a-f]{32})\/recoveries\/([^/]+)$/.exec(
          write.update?.name ?? "",
        );
        if (proofDoc === null) continue;
        const [, vault, rid] = proofDoc as unknown as [string, string, string];
        const docs = fake.documents(`vaults/${vault}`);
        const stored = docs.get(`vaults/${vault}`)?.fields.recoveryHash;
        const hash = stored !== undefined && "bytesValue" in stored ? stored.bytesValue : undefined;
        const proof = write.update?.fields.proof?.bytesValue;
        const rotated = writes.find((w) => w.update?.name.endsWith(`/vaults/${vault}`))?.update
          ?.fields.recoveryHash?.bytesValue;
        const valid =
          rid === caller &&
          !docs.has(`vaults/${vault}/recoveries/${rid}`) &&
          hash !== undefined &&
          proof !== undefined &&
          sha256b64(Buffer.from(proof, "base64")) === hash &&
          rotated !== undefined &&
          rotated !== hash;
        return valid ? fake.fetch(url, init) : deny();
      }
    }
    return members(url, init);
  };
}

function vaultHash(env: RelayHostEnv): string | undefined {
  const field = env.fake.documents(`vaults/${env.vault}`).get(`vaults/${env.vault}`)
    ?.fields.recoveryHash;
  return field !== undefined && "bytesValue" in field ? field.bytesValue : undefined;
}

function memberUidsOf(env: RelayHostEnv): string[] {
  return [...env.fake.documents(`vaults/${env.vault}/members/`).keys()].map(
    (path) => path.split("/").pop() as string,
  );
}

const deviceOf = (env: RelayHostEnv) =>
  env.fixture.vaultSource.provider.inventory[0]?.deviceId as string;

/** Replaces the data dir's relay identity and waits until the host marked the vault. */
async function loseIdentity(env: RelayHostEnv, host: LocalHost, name: string): Promise<string> {
  const uid = env.relay.auth.record?.uid as string;
  env.fake.expireUser(uid);
  env.fake.expireIdTokens();
  await renameVault(host, env.vault, name);
  env.timers.advance(RELAY_PUSH_DEBOUNCE_MS);
  // A back-off left by an earlier refusal delays the pass that meets the loss: wait it out.
  env.timers.advance(RELAY_BACKOFF_MAX_MS);
  await until(
    () =>
      host.relay.pending() === 0 &&
      env.relay.auth.record?.uid !== uid &&
      runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value
        ?.identityLostAt !== undefined,
  );
  await vaultQueueDrained(host, env.vault);
  return uid;
}

async function setupWithSecrets() {
  const env = await harness.setup();
  const secrets = new MemoryRecoverySecrets();
  const relay = {
    ...env.relay,
    fetch: recoveryRulesFetch(env.fake),
    recoverySecrets: () => secrets,
  };
  return { env, secrets, relay };
}

it("enable keeps a fresh recovery secret in the keychain before the commit that writes its hash", async () => {
  const { env, secrets, relay } = await setupWithSecrets();
  const vaultExistedAtSet: boolean[] = [];
  secrets.onSet = () => {
    vaultExistedAtSet.push(env.fake.documents(`vaults/${env.vault}`).has(`vaults/${env.vault}`));
  };
  const host = await enabledRelayHost(env, relay);
  expect(vaultExistedAtSet).toEqual([false]);
  const record = secrets.records.get(env.vault);
  expect(record?.current.length).toBe(32);
  expect(record?.next).toBeUndefined();
  expect(vaultHash(env)).toBe(sha256b64(record?.current as Uint8Array));
  // Never derived from anything the vault holds, never in the device store.
  const setting = runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  expect(JSON.stringify(setting)).not.toContain(b64(record?.current as Uint8Array));
  expect(setting?.memberUids[deviceOf(env)]).toEqual({
    uid: env.relay.auth.record?.uid,
    role: "admin",
  });
  expect(host.relay.status(env.vault)).toMatchObject({
    enabled: true,
    devices: 1,
    identityLost: false,
    canReconnect: false,
  });
  // Enabling again keeps the secret and the hash (no second secret).
  await host.relay.disable(env.vault);
  await host.relay.enable(env.vault);
  expect(secrets.records.get(env.vault)?.current).toEqual(record?.current);
  expect(vaultHash(env)).toBe(sha256b64(record?.current as Uint8Array));
});

it("reconnects after an identity loss: new uid admin under a new secret, old uid gone, passes resume", async () => {
  const { env, secrets, relay } = await setupWithSecrets();
  const host = await enabledRelayHost(env, relay);
  const first = secrets.records.get(env.vault)?.current as Uint8Array;
  const lostUid = await loseIdentity(env, host, "After the loss");
  await until(() => host.relay.status(env.vault).canReconnect);
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: true, canReconnect: true });
  const pushed = relayBytes(env.fake, env.vault);

  const client = await env.ui();
  expect(await client.call("native.relay.reconnect", { vault: env.vault })).toEqual({
    kind: "done",
  });
  client.close();
  const newUid = env.relay.auth.record?.uid as string;
  expect(newUid).not.toBe(lostUid);
  // Membership: only the new uid, as admin bound to this Mac.
  expect(memberUidsOf(env)).toEqual([newUid]);
  expect(
    env.fake.documents(`vaults/${env.vault}`).get(`vaults/${env.vault}/members/${newUid}`)?.fields,
  ).toMatchObject({ role: { stringValue: "admin" }, device: { stringValue: deviceOf(env) } });
  expect([...env.fake.documents(`vaults/${env.vault}/recoveries/`).keys()]).toEqual([]);
  // A NEW secret, confirmed: the relay holds its hash, the old one is spent.
  const record = secrets.records.get(env.vault);
  expect(record?.next).toBeUndefined();
  expect(record?.current).not.toEqual(first);
  expect(vaultHash(env)).toBe(sha256b64(record?.current as Uint8Array));
  const setting = runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  expect(setting?.identityLostAt).toBeUndefined();
  expect(setting?.memberUids[deviceOf(env)]).toEqual({ uid: newUid, role: "admin" });
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: false, canReconnect: false });
  // The passes resume at once: the writes made meanwhile reach the relay.
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > pushed);
  expect(host.relay.transportStatus(env.vault).lastError).toBeUndefined();
});

it("refuses no_recovery_secret without a kept secret, and never offers the action", async () => {
  // Options that keep no secrets (a vault enabled before secrets existed behaves the same).
  const env = await harness.setup();
  const host = await enabledRelayHost(env, { ...env.relay, fetch: recoveryRulesFetch(env.fake) });
  expect(vaultHash(env)).toBeUndefined();
  await loseIdentity(env, host, "No secret");
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: true, canReconnect: false });
  expect(await host.relay.reconnect(env.vault)).toEqual({
    result: { kind: "refused", reason: "no_recovery_secret" },
    reopen: false,
  });

  // A keychain that lost the secret.
  const second = await setupWithSecrets();
  const other = await enabledRelayHost(second.env, second.relay);
  second.secrets.records.clear();
  await loseIdentity(second.env, other, "Keychain lost");
  await vaultQueueDrained(other, second.env.vault);
  expect(other.relay.status(second.env.vault).canReconnect).toBe(false);
  expect(await other.relay.reconnect(second.env.vault)).toEqual({
    result: { kind: "refused", reason: "no_recovery_secret" },
    reopen: false,
  });
  expect(other.relay.status(second.env.vault).identityLost).toBe(true);
});

it("survives a lost confirmation and a second identity loss: both secrets kept until one is confirmed", async () => {
  const { env, secrets, relay } = await setupWithSecrets();
  const host = await enabledRelayHost(env, relay);
  const a = secrets.records.get(env.vault)?.current as Uint8Array;
  const uid1 = await loseIdentity(env, host, "First loss");

  // The recovery commit lands but its answer is lost: the Mac cannot tell, it keeps both secrets.
  env.fake.faults.loseNextCommitResponse();
  expect((await host.relay.reconnect(env.vault)).result).toEqual({
    kind: "refused",
    reason: "offline",
  });
  const pending = secrets.records.get(env.vault);
  expect(pending?.current).toEqual(a);
  const b = pending?.next as Uint8Array;
  expect(b.length).toBe(32);
  // The relay already holds the next secret's hash, and uid2 is admin there.
  expect(vaultHash(env)).toBe(sha256b64(b));
  const uid2 = env.relay.auth.record?.uid as string;
  expect(memberUidsOf(env).sort()).toEqual([uid1, uid2].sort());

  // The identity is lost again before a retry: only the pending secret still matches the relay.
  env.fake.faults.reset();
  await loseIdentity(env, host, "Second loss");
  expect((await host.relay.reconnect(env.vault)).result).toEqual({ kind: "done" });
  const uid3 = env.relay.auth.record?.uid as string;
  // Proved with `b`, rotated back to `a` (both stayed in the keychain): confirmed and single again.
  expect(secrets.records.get(env.vault)).toEqual({ current: a });
  expect(vaultHash(env)).toBe(sha256b64(a));
  // Every earlier uid of this Mac is gone; only the new one is bound.
  expect(memberUidsOf(env)).toEqual([uid3]);
});

it("a commit that never reached the relay keeps the old secret valid for the retry", async () => {
  const { env, secrets, relay } = await setupWithSecrets();
  const host = await enabledRelayHost(env, relay);
  const a = secrets.records.get(env.vault)?.current as Uint8Array;
  await loseIdentity(env, host, "Loss");
  env.fake.faults.unavailable(1);
  expect((await host.relay.reconnect(env.vault)).result).toEqual({
    kind: "refused",
    reason: "offline",
  });
  // Nothing changed at the relay; the next secret waits in the keychain beside the old one.
  expect(vaultHash(env)).toBe(sha256b64(a));
  const pending = secrets.records.get(env.vault);
  expect(pending?.current).toEqual(a);
  expect(pending?.next).toBeDefined();
  expect((await host.relay.reconnect(env.vault)).result).toEqual({ kind: "done" });
  expect(secrets.records.get(env.vault)).toEqual({ current: pending?.next });
  expect(vaultHash(env)).toBe(sha256b64(pending?.next as Uint8Array));
});

it("reconnects under the uid that replaced a stale one during the call", async () => {
  const { env, secrets, relay } = await setupWithSecrets();
  const host = await enabledRelayHost(env, relay);
  await loseIdentity(env, host, "Loss");
  // The current identity is replaced too, but no pass has noticed yet: the reconnect starts with a
  // cached uid the relay no longer accepts and finishes under the new one.
  const stale = env.relay.auth.record?.uid as string;
  env.fake.expireUser(stale);
  env.fake.expireIdTokens();
  expect((await host.relay.reconnect(env.vault)).result).toEqual({ kind: "done" });
  const fresh = env.relay.auth.record?.uid as string;
  expect(fresh).not.toBe(stale);
  expect(memberUidsOf(env)).toEqual([fresh]);
  expect(vaultHash(env)).toBe(sha256b64(secrets.records.get(env.vault)?.current as Uint8Array));
  expect(host.relay.status(env.vault)).toMatchObject({ identityLost: false, canReconnect: false });
});

it("binds and unbinds a phone through the relay admin, its role kept in the setting", async () => {
  const { env, relay } = await setupWithSecrets();
  const host = await enabledRelayHost(env, relay);
  const phone = "d2000000000000000000000000000002";
  await host.relay.addMember(env.vault, { device: phone, uid: "phone-uid", role: "member" });
  expect(
    env.fake.documents(`vaults/${env.vault}`).get(`vaults/${env.vault}/members/phone-uid`)?.fields,
  ).toMatchObject({ role: { stringValue: "member" }, device: { stringValue: phone } });
  const setting = runQuery(host.stores.device.store, relaySetting, { vault: env.vault }).value;
  expect(setting?.memberUids[phone]).toEqual({ uid: "phone-uid", role: "member" });
  expect(host.relay.status(env.vault).devices).toBe(2);
  await host.relay.removeMember(env.vault, phone);
  expect(memberUidsOf(env)).toEqual([env.relay.auth.record?.uid]);
  expect(host.relay.status(env.vault).devices).toBe(1);
  // Unknown device: nothing to do.
  await host.relay.removeMember(env.vault, phone);
});
