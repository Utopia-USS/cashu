// FirestorePairingLink under the security rules (/firestore.rules), against the Firestore + Auth
// emulators: the inviter is the vault's admin created through FirestoreRelayAdmin.createVault, the joiner a
// fresh anonymous identity that is never admitted as a member. Skipped unless the emulators run (`pnpm
// test:emulator` at the repo root; project `demo-cashu` only). Every test uses its own named database
// (the rules suite clears the default one). Synthetic vault, devices and bytes only.
import { describe, expect, it } from "vitest";
import { PairingInviter, PairingJoiner } from "../../devices/pairing.js";
import { runInviter, runJoiner } from "../../devices/pairingLink.js";
import { createSimVault, newEid, SimDevice, sodium } from "../../testing/devices/testkit.js";
import { MemoryAuthStore } from "../../testing/firestore-fake.js";
import { AnonymousAuth } from "./auth.js";
import {
  type EmulatorHosts,
  emulatorEndpoint,
  emulatorHosts,
  emulatorIdentity,
  ownerRest,
} from "./emulator.js";
import { FirestorePairingLink, PairingLinkError, pairingSessionId } from "./pairingLink.js";
import { FirestoreRelayAdmin } from "./relayAdmin.js";
import { FirestoreRest, FirestoreRestError } from "./rest.js";

const hosts = emulatorHosts();
const MAC = "ac".repeat(16);

let databases = 0;

interface Actor {
  readonly uid: string;
  readonly rest: FirestoreRest;
}

/** "ok" or the PairingLinkError / REST error code of the call. */
async function code(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof PairingLinkError || error instanceof FirestoreRestError) return error.code;
    throw error;
  }
}

/** A fresh named database and anonymous actors in it. */
function world(h: EmulatorHosts) {
  const database = `p-${Math.floor(Math.random() * 0xffffffff).toString(16)}-${++databases}`;
  const actor = async (): Promise<Actor> => {
    const auth = new AnonymousAuth({ endpoint: emulatorIdentity(h), store: new MemoryAuthStore() });
    const rest = new FirestoreRest({ endpoint: emulatorEndpoint(h, database), auth, retries: 0 });
    return { uid: await auth.uid(), rest };
  };
  const link = (who: Actor, vault: string, sessionId: string, side: "inviter" | "joiner") =>
    new FirestorePairingLink({
      rest: who.rest,
      uid: async () => who.uid,
      vault,
      sessionId,
      side,
      pollMs: 100,
      receiveTimeoutMs: 30_000,
    });
  /** Every document path under `prefix`, read as the rules-bypassing owner (collection by collection). */
  const owner = ownerRest(h, database);
  return { actor, link, owner };
}

describe.skipIf(!hosts)("FirestorePairingLink (emulator, security rules)", () => {
  it("pairs a never-admitted joiner with the admin inviter, and close leaves no documents", async () => {
    if (!hosts) return;
    const w = world(hosts);
    const { creator } = createSimVault();
    const created = PairingInviter.create({
      sodium,
      identity: creator.identity,
      ring: creator.ring,
      registry: creator.devices.registry,
      now: creator.now(),
    });
    if (!created.ok) throw new Error(created.reason);
    const vault = created.value.inviter.invite.vaultId;
    const sid = pairingSessionId(created.value.inviter.invite);
    const mac = await w.actor();
    const phoneActor = await w.actor();
    expect(
      await new FirestoreRelayAdmin({ rest: mac.rest }).createVault(vault, {
        uid: mac.uid,
        device: creator.id,
      }),
    ).toBe("created");
    const inviterLink = w.link(mac, vault, sid, "inviter");
    const joinerLink = w.link(phoneActor, vault, sid, "joiner");
    await inviterLink.open(Date.now() + 5 * 60_000);

    const phone = new SimDevice("phone", creator.remote);
    const started = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      created.value.qr,
      phone.now(),
    );
    if (!started.ok) throw new Error(started.reason);
    await joinerLink.claim();
    let sas: string | undefined;
    const [inv, join] = await Promise.all([
      runInviter(created.value.inviter, inviterLink, {
        now: () => creator.now(),
        eid: newEid,
        enterCode: async () => sas,
      }),
      runJoiner(started.value.joiner, started.value.hello, joinerLink, {
        now: () => phone.now(),
        showSas: (shown) => {
          sas = shown;
        },
      }),
    ]);
    expect(inv.ok && join.ok).toBe(true);
    expect(await inviterLink.joinerUid()).toBe(phoneActor.uid);
    const prefix = `vaults/${vault}/pairings/${sid}`;
    expect((await w.owner.runQuery(prefix, { collectionId: "messages" })).length).toBeGreaterThan(
      3,
    );
    await inviterLink.close();
    expect(await w.owner.get(prefix)).toBeUndefined();
    expect(await w.owner.runQuery(prefix, { collectionId: "messages" })).toEqual([]);
  });

  it("keeps a stranger out: no message read, no claim of a claimed session, no message write", async () => {
    if (!hosts) return;
    const w = world(hosts);
    const vault = "c1".repeat(16);
    const sid = "5e".repeat(16);
    const [mac, phone, stranger] = await Promise.all([w.actor(), w.actor(), w.actor()]);
    await new FirestoreRelayAdmin({ rest: mac.rest }).createVault(vault, {
      uid: mac.uid,
      device: MAC,
    });
    const inviter = w.link(mac, vault, sid, "inviter");
    await inviter.open(Date.now() + 5 * 60_000);
    const joiner = w.link(phone, vault, sid, "joiner");
    await joiner.claim();
    await joiner.send(new Uint8Array(48).fill(1));
    await inviter.send(new Uint8Array(48).fill(2));
    const prefix = `vaults/${vault}/pairings/${sid}`;
    expect(await code(stranger.rest.get(`${prefix}/messages/0000`))).toBe("permission-denied");
    expect(await code(stranger.rest.get(`${prefix}/messages/0001`))).toBe("permission-denied");
    expect(await code(stranger.rest.runQuery(prefix, { collectionId: "messages" }))).toBe(
      "permission-denied",
    );
    expect(await code(w.link(stranger, vault, sid, "joiner").claim())).toBe("taken");
    // A stranger posing as the joiner cannot write the joiner's next number.
    expect(await code(w.link(stranger, vault, sid, "joiner").send(new Uint8Array(8)))).not.toBe(
      "ok",
    );
    expect(await w.owner.get(`${prefix}/messages/0003`)).toBeUndefined();
    expect(await inviter.receive()).toEqual(new Uint8Array(48).fill(1));
    expect(await joiner.receive()).toEqual(new Uint8Array(48).fill(2));
  });

  it("a claimer who is never admitted cannot claim or write after expiry", async () => {
    if (!hosts) return;
    const w = world(hosts);
    const vault = "c2".repeat(16);
    const sid = "6f".repeat(16);
    const late = "70".repeat(16);
    const [mac, phone, other] = await Promise.all([w.actor(), w.actor(), w.actor()]);
    await new FirestoreRelayAdmin({ rest: mac.rest }).createVault(vault, {
      uid: mac.uid,
      device: MAC,
    });
    const inviter = w.link(mac, vault, sid, "inviter");
    await inviter.open(Date.now() + 3_000);
    await w.link(mac, vault, late, "inviter").open(Date.now() + 3_000);
    const joiner = w.link(phone, vault, sid, "joiner");
    await joiner.claim();
    await joiner.send(new Uint8Array(16).fill(3));
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    // The link refuses by its own clock; the rules refuse by the server's (a raw write, no link).
    expect(await code(joiner.send(new Uint8Array(16).fill(4)))).toBe("expired");
    const prefix = `vaults/${vault}/pairings/${sid}`;
    const raw = await code(
      phone.rest.commit([
        {
          update: {
            name: `${prefix}/messages/0003`,
            fields: {
              from: { stringValue: phone.uid },
              n: { integerValue: "3" },
              box: { bytesValue: "AAAA" },
              part: { integerValue: "0" },
              parts: { integerValue: "1" },
              createdAt: { timestampValue: new Date().toISOString() },
            },
          },
        },
      ]),
    );
    expect(raw).toBe("permission-denied");
    expect(await code(w.link(other, vault, late, "joiner").claim())).toBe("expired");
    // The message written before expiry still arrives; the admin can still clean up.
    expect(await inviter.receive()).toEqual(new Uint8Array(16).fill(3));
    await inviter.close();
    expect(await w.owner.get(prefix)).toBeUndefined();
  });
});
