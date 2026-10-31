import { describe, expect, it } from "vitest";
import { createDeviceIdentity, openFrame, sealFrame } from "../crypto/index.js";
import { fromUtf8, toHex } from "./bytes.js";
import {
  decodeInvite,
  encodeInvite,
  PairingInviter,
  PairingJoiner,
  shortAuthenticationString,
} from "./pairing.js";
import { runInviter, runJoiner } from "./pairingLink.js";
import { createSimVault, memoryLinks, newEid, pairDevice, SimDevice, sodium } from "./testkit.js";

const plain = new TextEncoder().encode("synthetic frame");

function invite(inviter: SimDevice, now = inviter.now()) {
  const created = PairingInviter.create({
    sodium,
    identity: inviter.identity,
    ring: inviter.ring,
    registry: inviter.devices.registry,
    now,
  });
  if (!created.ok) throw new Error(created.reason);
  return created.value;
}

describe("pairing", () => {
  it("pairs three devices; each trusts the others and reads the same frames", async () => {
    const { creator } = createSimVault();
    const phone = await pairDevice(creator, "phone");
    const laptop = await pairDevice(phone, "laptop");
    for (const d of [creator, phone, laptop]) d.sync();
    for (const d of [creator, phone, laptop]) {
      const reg = d.devices.registry;
      expect([...reg.trusted.keys()].sort()).toEqual([creator.id, phone.id, laptop.id].sort());
      expect(reg.devices.get(phone.id)?.name).toBe("phone");
      expect(reg.devices.get(laptop.id)?.name).toBe("laptop");
      expect(reg.ignored).toEqual([]);
    }
    expect(phone.ring.vaultId).toBe(creator.ring.vaultId);
    expect(phone.ring.gidSalt().expose()).toEqual(creator.ring.gidSalt().expose());
    const ctx = { vaultId: creator.ring.vaultId, deviceId: creator.id, segment: 1, offset: 0 };
    const frame = sealFrame(sodium, creator.ring, plain, ctx);
    expect(openFrame(sodium, laptop.ring, frame, ctx)).toEqual(plain);
  });

  it("the QR round-trips and carries no secret", () => {
    const { creator } = createSimVault();
    const { qr, inviter } = invite(creator);
    expect(decodeInvite(qr)?.inviter).toBe(creator.id);
    expect(encodeInvite(inviter.invite)).toBe(qr);
    expect(qr).not.toContain(toHex(creator.identity.box.publicKey));
    expect(decodeInvite(`${qr}x`)).toBeUndefined();
    expect(decodeInvite("cashu-pair:{}")).toBeUndefined();
  });

  it("a man in the middle that substitutes its keys is caught by the SAS; nothing is sealed", async () => {
    const { creator } = createSimVault();
    const phone = new SimDevice("phone", creator.remote);
    const mallory = createDeviceIdentity(sodium);
    const { inviter, qr } = invite(creator);
    const real = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      qr,
      phone.now(),
    );
    const fake = PairingJoiner.start({ sodium, identity: mallory, name: "phone" }, qr, phone.now());
    if (!real.ok || !fake.ok) throw new Error("scan failed");

    // The link replaces the phone's hello and reveal with Mallory's and hands the inviter's
    // challenge to Mallory, who answers it and re-seals it for the phone.
    let challengeForMallory: Uint8Array | undefined;
    const links = memoryLinks({
      toInviter: (m) => {
        if (m === real.value.hello) return fake.value.hello;
        if (challengeForMallory) {
          const answered = fake.value.joiner.receiveChallenge(challengeForMallory, phone.now());
          return answered.ok ? answered.value.reply : undefined;
        }
        return m;
      },
      toJoiner: (m) => {
        if (challengeForMallory) return m;
        challengeForMallory = m;
        const opened = sodium.sealOpen(m, mallory.box.publicKey, mallory.box.secretKey.expose());
        return sodium.seal(opened, phone.identity.box.publicKey);
      },
    });
    let inviterSas: string | undefined;
    let phoneSas: string | undefined;
    const [inv, join] = await Promise.all([
      runInviter(inviter, links.inviter, {
        now: () => creator.now(),
        confirmSas: async (sas) => {
          inviterSas = sas;
          return sas === phoneSas; // the owner compares both screens
        },
        eid: newEid,
      }),
      runJoiner(real.value.joiner, real.value.hello, links.joiner, {
        now: () => phone.now(),
        showSas: (sas) => {
          phoneSas = sas;
        },
      }),
    ]);
    expect(inviterSas).toMatch(/^\d{6}$/);
    expect(phoneSas).not.toBe(inviterSas);
    expect(inv.ok).toBe(false);
    if (!inv.ok) expect(inv.reason).toBe("sas_rejected");
    // The phone refused the challenge signed over Mallory's keys: it never showed a SAS.
    expect(join.ok).toBe(false);
    if (!join.ok) expect(join.reason).toBe("bad_signature");
    expect(inviter.state).toBe("done");
    expect(inviter.confirm(newEid()).ok).toBe(false);
  });

  it("commit-then-reveal: a nonce other than the committed one is refused", () => {
    const { creator } = createSimVault();
    const phone = new SimDevice("phone", creator.remote);
    const { inviter, qr } = invite(creator);
    const s = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      qr,
      phone.now(),
    );
    if (!s.ok) throw new Error("scan failed");
    const ch = inviter.receiveHello(s.value.hello, creator.now());
    if (!ch.ok) throw new Error(ch.reason);
    // Anyone can seal to the QR's ephemeral key: a reveal with a nonce chosen after the challenge.
    const reveal = { t: "reveal", s: inviter.session, r: toHex(sodium.randomBytes(32)) };
    const forged = sodium.seal(
      new TextEncoder().encode(JSON.stringify(reveal)),
      inviter.invite.ephemeralPublicKey,
    );
    const out = inviter.receiveReveal(forged);
    expect(out.ok ? "" : out.reason).toBe("commit_mismatch");
    expect(out.ok ? undefined : out.reply).toBeInstanceOf(Uint8Array);
    // The session is dead: the genuine reveal is not accepted afterwards.
    const genuine = s.value.joiner.receiveChallenge(ch.value.reply, phone.now());
    if (!genuine.ok) throw new Error(genuine.reason);
    expect(inviter.receiveReveal(genuine.value.reply).ok).toBe(false);
  });

  it("both screens show the same SAS on the happy path, and it is bound to both nonces", async () => {
    const { creator } = createSimVault();
    const phone = new SimDevice("phone", creator.remote);
    const { inviter, qr } = invite(creator);
    const s = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      qr,
      phone.now(),
    );
    if (!s.ok) throw new Error("scan failed");
    const ch = inviter.receiveHello(s.value.hello, creator.now());
    if (!ch.ok) throw new Error(ch.reason);
    const rv = s.value.joiner.receiveChallenge(ch.value.reply, phone.now());
    if (!rv.ok) throw new Error(rv.reason);
    const shown = inviter.receiveReveal(rv.value.reply);
    if (!shown.ok) throw new Error(shown.reason);
    expect(shown.value.sas).toBe(rv.value.sas);
    const t = sodium.randomBytes(32);
    expect(shortAuthenticationString(sodium, t, new Uint8Array(32))).not.toBe(
      shortAuthenticationString(sodium, t, new Uint8Array(32).fill(1)),
    );
    const welcome = inviter.confirm(newEid());
    if (!welcome.ok) throw new Error(welcome.reason);
    const done = s.value.joiner.receiveWelcome(welcome.value.reply);
    expect(done.ok).toBe(true);
  });

  it("a tampered welcome (other wrap, other registry) is refused", () => {
    const { creator } = createSimVault();
    const phone = new SimDevice("phone", creator.remote);
    const { inviter, qr } = invite(creator);
    const s = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      qr,
      phone.now(),
    );
    if (!s.ok) throw new Error("scan failed");
    const ch = inviter.receiveHello(s.value.hello, creator.now());
    if (!ch.ok) throw new Error(ch.reason);
    const rv = s.value.joiner.receiveChallenge(ch.value.reply, phone.now());
    if (!rv.ok) throw new Error(rv.reason);
    if (!inviter.receiveReveal(rv.value.reply).ok) throw new Error("reveal");
    const welcome = inviter.confirm(newEid());
    if (!welcome.ok) throw new Error(welcome.reason);
    // Re-seal the welcome with the registry list emptied (the link can seal for the phone's key).
    const opened = JSON.parse(
      fromUtf8(
        sodium.sealOpen(
          welcome.value.reply,
          phone.identity.box.publicKey,
          phone.identity.box.secretKey.expose(),
        ),
      ),
    );
    const forged = sodium.seal(
      new TextEncoder().encode(JSON.stringify({ ...opened, reg: [] })),
      phone.identity.box.publicKey,
    );
    const out = s.value.joiner.receiveWelcome(forged);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("bad_signature");
  });

  it("refuses clocks more than 5 minutes apart, accepts 4 minutes", async () => {
    const { creator } = createSimVault();
    const ok = await pairDevice(creator, "phone", 4 * 60_000);
    expect(ok.devices.registry.isTrusted(ok.id)).toBe(true);

    const late = new SimDevice("watch", creator.remote, 6 * 60_000);
    const { inviter, qr } = invite(creator);
    const s = PairingJoiner.start(
      { sodium, identity: late.identity, name: "watch" },
      qr,
      late.now(),
    );
    if (!s.ok) throw new Error("scan failed");
    const ch = inviter.receiveHello(s.value.hello, creator.now());
    expect(ch.ok).toBe(false);
    if (!ch.ok) expect(ch.reason).toBe("clock_skew");
  });

  it("refuses an expired invite, a registered device id and an untrusted inviter", async () => {
    const { creator } = createSimVault();
    const { inviter, qr } = invite(creator);
    const phone = new SimDevice("phone", creator.remote);
    const s = PairingJoiner.start(
      { sodium, identity: phone.identity, name: "phone" },
      qr,
      phone.now(),
    );
    if (!s.ok) throw new Error("scan failed");
    const expired = inviter.receiveHello(s.value.hello, creator.now() + 6 * 60_000);
    expect(expired.ok ? "" : expired.reason).toBe("expired");

    const second = invite(creator);
    const again = PairingJoiner.start(
      { sodium, identity: creator.identity, name: "creator" },
      second.qr,
      creator.now(),
    );
    expect(again.ok ? "" : again.reason).toBe("already_registered");

    const stranger = new SimDevice("stranger", creator.remote);
    stranger.attach(creator.ring.clone(sodium), []);
    const refused = PairingInviter.create({
      sodium,
      identity: stranger.identity,
      ring: stranger.ring,
      registry: stranger.devices.registry,
      now: stranger.now(),
    });
    expect(refused.ok ? "" : refused.reason).toBe("not_trusted");
  });
});
