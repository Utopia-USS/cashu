// S29c R4 (S29-review.md R4, lead decision D3 / D4): rule 6 must not rest on an unstated
// linearizable remote. The fetch leader is pinned to the creator on every backend and moves only by
// an owner pin with the old leader's acknowledgement (or an owner-confirmed force); automatic
// handover is an owner opt-in that works only over a transport declaring bounded propagation.
// The sweeps are lease.rule6.exhaustive.test.ts; one schedule of each kind runs here.

import { describe, expect, it } from "vitest";
import { createRecoveryKey, recoveryIdentity } from "../crypto/index.js";
import {
  type Backend,
  boundedConfig,
  config,
  decide,
  devices,
  holds,
  MIN,
  pin,
  pinnedRun,
  rule6Run,
  siblingRun,
  view,
  visibilityOf,
} from "../testing/devices/leaseSim.js";
import {
  hlcAt,
  newEid,
  prepareConsented,
  prepareReviewedRevocation,
  type SimDevice,
  START_CURSOR,
  sodium,
} from "../testing/devices/testkit.js";
import { fromHex, toHex } from "./bytes.js";
import { buildLeaseClaim, buildLeasePin, pinConfirmationText } from "./events.js";
import { nextLeaseStep, pinEventFor } from "./lease.js";

const BACKENDS: readonly Backend[] = ["linearizable", "bounded", "eventual"];

function syncAll(all: readonly SimDevice[], rounds = 2): void {
  for (let i = 0; i < rounds; i++) for (const d of all) d.sync();
}

function step(d: SimDevice): string {
  return nextLeaseStep(view(d), d.local(), true, config).kind;
}

function reasonOf(d: SimDevice, eid: string): string | undefined {
  return view(d).ignored.find((i) => i.eid === eid)?.reason;
}

function rawClaim(d: SimDevice): string {
  const eid = newEid();
  d.write([
    buildLeaseClaim(d.identity, d.ring.vaultId, eid, {
      at: d.now(),
      until: d.now() + 30 * MIN,
      watermark: {},
      prev: view(d).head,
    }),
  ]);
  return eid;
}

describe("R4: the creator is the pinned fetch leader on every backend", () => {
  it.each(BACKENDS)("over a %s remote only the creator leads; claims are ignored", async (b) => {
    const {
      a,
      b: phone,
      c,
      remote,
    } = await devices([0, 0, 0], {
      mode: "pinned",
      visibility: visibilityOf(b),
    });
    remote.flush();
    syncAll([a, phone, c]);
    for (const d of [a, phone, c]) {
      expect(view(d)).toMatchObject({ mode: "pinned", pinned: a.id, pendingFrom: null });
    }
    expect([step(a), step(phone), step(c)]).toEqual(["lead", "idle", "idle"]);
    expect(holds(a)).toBe(true);
    const claim = rawClaim(phone);
    syncAll([a, phone, c]);
    for (const d of [a, phone, c]) expect(reasonOf(d, claim), d.name).toBe("pinned_mode");
    expect([a, phone, c].filter(holds)).toEqual([a]);
  });
});

describe("R4: moving the leader", () => {
  it("a re-pin waits for the old leader's acknowledgement; a forced one does not (D4)", async () => {
    const { a, b, c, remote } = await devices([0, 0, 0], {
      mode: "pinned",
      visibility: visibilityOf("eventual"),
    });
    remote.flush();
    pin(b, "pinned", c); // the owner, on the phone, makes the laptop the fetcher
    syncAll([b, c]);
    expect(view(c)).toMatchObject({ pinned: c.id, pendingFrom: a.id });
    expect(nextLeaseStep(view(c), c.local(), true, config)).toEqual({
      kind: "handover_wait",
      from: a.id,
    });
    expect(holds(c)).toBe(false);
    a.pull(() => false); // A pulls, but the folder has not shown it the pin yet
    expect(holds(a)).toBe(true); // it is still the only leader
    a.sync();
    expect(holds(a)).toBe(false);
    expect(decide(a)).toBe("release"); // the hand-over ack
    syncAll([a, b, c]);
    expect(view(c).pendingFrom).toBeNull();
    expect(holds(c)).toBe(true);
    expect([a, b, c].filter(holds)).toEqual([c]);

    // The laptop is lost: the owner force-pins the phone. It leads at once; a laptop still running
    // somewhere and not yet seeing the pin may fetch once more (the UI warns, D4).
    pin(b, "pinned", b, { force: true });
    b.sync();
    expect(view(b)).toMatchObject({ pinned: b.id, pendingFrom: null, pin: { force: true } });
    expect(holds(b)).toBe(true);
    c.pull(() => false); // the laptop has not seen the forced pin
    expect(holds(c)).toBe(true);
    c.sync();
    expect(holds(c)).toBe(false);
    expect([a, b, c].filter(holds)).toEqual([b]);
  });

  it("the old leader writing the pin itself needs no acknowledgement", async () => {
    const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
    remote.flush();
    pin(a, "pinned", b);
    syncAll([a, b, c]);
    expect(view(b).pendingFrom).toBeNull();
    expect([a, b, c].filter(holds)).toEqual([b]);
  });

  it("a recovery-signed pin counts whichever device carries it", async () => {
    const { a, b, c, recovery } = await devices([0, 0, 0], { mode: "pinned" });
    pin(c, "pinned", b, { recovery, force: true });
    syncAll([a, b, c]);
    for (const d of [a, b, c]) expect(view(d).pinned, d.name).toBe(b.id);
    expect(view(a).recoveryPins).toHaveLength(2); // the creator's pin and this one
  });
});

describe("R4: re-pin attacks are ignored", () => {
  it("without the owner's typed confirmation", async () => {
    const { a, b, c } = await devices([0, 0, 0], { mode: "pinned" });
    pin(c, "pinned", c, { text: "please" });
    pin(c, "pinned", c, { text: pinConfirmationText("pinned", c.id, false), force: true }); // force not typed
    syncAll([a, b, c]);
    const pins = c.stream.flatMap((s) => s.events).filter((e) => e.type === "lease.pinned");
    for (const e of pins) expect(reasonOf(a, e.eid)).toBe("unconfirmed");
    expect(view(a).pinned).toBe(a.id);
    expect([a, b, c].filter(holds)).toEqual([a]);
  });

  it("by a revoked device after its cut (it has not seen its revocation yet)", async () => {
    const { a, b, c, recovery } = await devices([0, 0, 0], { mode: "pinned" });
    const r = prepareConsented(a, [c], recovery);
    if (!r.ok) throw new Error(r.reason);
    a.write(r.change.events);
    r.change.commit();
    a.push();
    pin(c, "pinned", c, { force: true }); // C's view still trusts itself
    c.push();
    b.pull();
    a.pull();
    for (const d of [a, b]) {
      expect(view(d).pinned, d.name).toBe(a.id);
      const theirs = c.stream.flatMap((s) => s.events).find((e) => e.type === "lease.pinned");
      expect(reasonOf(d, theirs?.eid ?? ""), d.name).toBe("untrusted_writer");
    }
    expect([a, b].filter(holds)).toEqual([a]);
  });

  it("with a forged recovery signature, or the words replaced since; the creator's pin survives a recovery change", async () => {
    const { a, b, c, recovery } = await devices([0, 0, 0], { mode: "pinned" });
    // Forged: a recovery-signed pin whose signature was altered.
    const eid = newEid();
    const event = buildLeasePin(
      c.identity,
      c.ring.vaultId,
      eid,
      { at: c.now(), watermark: {}, prev: view(c).head },
      { mode: "pinned", leader: c.id, force: true, confirmation: { kind: "recovery", recovery } },
    );
    const sig = fromHex(event.d.sig as string);
    sig[0] = (sig[0] ?? 0) ^ 1;
    c.write([{ ...event, d: { ...event.d, sig: toHex(sig) } }]);
    syncAll([a, b, c]);
    expect(reasonOf(a, eid)).toBe("bad_signature");
    // The owner replaces the words: the creator's pin (signed with the old words) is ratified.
    const next = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    a.write([a.devices.prepareRecoveryChange(recovery, next, newEid())]);
    syncAll([a, b, c]);
    for (const d of [a, b, c]) expect(view(d).pinned, d.name).toBe(a.id);
    expect(holds(a)).toBe(true);
    // A pin signed with the replaced words after the change never counts (leaked old phrase).
    pin(c, "pinned", c, { recovery, force: true });
    syncAll([a, b, c]);
    expect(view(a).pinned).toBe(a.id);
    expect(view(a).ignored.at(-1)?.reason).toBe("bad_signature");
  });

  it("a device-signed pin cannot root the chain; a pin naming an unknown device leaves no leader", async () => {
    const { a, b, c } = await devices([0, 0, 0], { mode: "pinned" });
    const root = newEid();
    const text = pinConfirmationText("pinned", c.id, true);
    c.write([
      buildLeasePin(
        c.identity,
        c.ring.vaultId,
        root,
        { at: c.now(), watermark: {}, prev: null },
        { mode: "pinned", leader: c.id, force: true, confirmation: { kind: "typed", text } },
      ),
    ]);
    syncAll([a, b, c]);
    expect(reasonOf(a, root)).toBe("not_root");
    // An owner mistake (or a stolen device before its revocation) pins a device nobody knows: the
    // vault is leaderless (nobody fetches) until the owner re-pins; the liveness warning shows it.
    const ghost = "f".repeat(32);
    c.write([
      pinEventFor(
        view(c),
        {
          identity: c.identity,
          vaultId: c.ring.vaultId,
          eid: newEid(),
          now: c.now(),
          applied: c.applied,
        },
        {
          mode: "pinned",
          leader: ghost,
          force: true,
          confirmation: { kind: "typed", text: pinConfirmationText("pinned", ghost, true) },
        },
        c.local(),
      ),
    ]);
    syncAll([a, b, c]);
    expect(view(a)).toMatchObject({ pinned: ghost, free: true });
    expect([a, b, c].filter(holds)).toEqual([]);
  });
});

/** A typed pin by `d` naming `leader` on top of `prev`, stamped (HLC and `at`) at `wall`. */
function pinAt(d: SimDevice, leader: SimDevice, prev: string, wall: number): string {
  const eid = newEid();
  const text = pinConfirmationText("pinned", leader.id, false);
  d.write(
    [
      buildLeasePin(
        d.identity,
        d.ring.vaultId,
        eid,
        { at: wall, watermark: {}, prev },
        { mode: "pinned", leader: leader.id, force: false, confirmation: { kind: "typed", text } },
      ),
    ],
    { hlc: () => hlcAt(d.id, wall) },
  );
  return eid;
}

describe("S1: sibling pins never make the old leader hand over twice", () => {
  it("a backdated sibling pin does not win after the old leader acknowledged another", async () => {
    const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
    remote.flush();
    syncAll([a, b, c]);
    const root = view(b).head as string;
    pin(b, "pinned", c); // the owner moves the leader to the laptop
    syncAll([a, b, c]);
    expect(decide(a)).toBe("release");
    syncAll([a, b, c]);
    expect([a, b, c].filter(holds)).toEqual([c]);
    // A trusted device writes a sibling of that pin (same `prev`), stamped earlier, naming itself.
    const sibling = pinAt(b, b, root, b.now() - 2 * MIN);
    b.push();
    a.pull();
    expect(decide(a)).toBe("idle"); // A acknowledged the laptop's pin first: no second hand-over
    a.push();
    b.pull();
    c.pull(() => false); // the laptop has not seen any of it
    expect([a, b, c].filter(holds)).toEqual([c]);
    syncAll([a, b, c]);
    for (const d of [a, b, c]) expect(view(d).pinned, d.name).toBe(c.id);
    expect(reasonOf(a, sibling)).toBe("stale_prev");
  });

  it("S1b: retiring the old leader after its hand-over does not void its acknowledgement", async () => {
    const { a, b, c, remote, recovery } = await devices([0, 0, 0], { mode: "pinned" });
    remote.flush();
    syncAll([a, b, c]);
    const root = view(b).head as string;
    pin(b, "pinned", c);
    syncAll([a, b, c]);
    expect(decide(a)).toBe("release");
    syncAll([a, b, c]);
    expect([a, b, c].filter(holds)).toEqual([c]);
    // The owner retires the old desktop (it certified everyone: words, re-certifying the others).
    const r = prepareReviewedRevocation(
      b,
      [{ device: a.id, cut: b.cursors.get(a.id) ?? START_CURSOR }],
      { revoke: newEid(), rotate: newEid(), recertify: newEid },
      recovery,
      { recertify: [b.id, c.id] },
    );
    if (!r.ok) throw new Error(r.reason);
    b.write(r.change.events);
    r.change.commit();
    // A stale sibling of the laptop's pin, stamped earlier, naming the phone.
    pinAt(b, b, root, b.now() - 2 * MIN);
    b.push();
    b.pull();
    c.pull(() => false); // the laptop has seen neither the retirement nor the sibling
    expect(view(b).pinned).toBe(c.id); // the retired desktop's earlier acknowledgement still counts
    expect([a, b, c].filter(holds)).toEqual([c]);
    syncAll([b, c]);
    expect([b, c].filter(holds)).toEqual([c]);
  });

  it("an offline tablet's earlier pin arriving later does not move the leader again", async () => {
    const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
    remote.flush();
    syncAll([a, b, c]);
    pin(c, "pinned", c); // on the tablet, offline: not pushed
    remote.time += MIN;
    pin(b, "pinned", b); // later, on the phone
    b.push();
    a.pull();
    expect(decide(a)).toBe("release");
    a.push();
    b.pull();
    expect(holds(b)).toBe(true);
    // The tablet comes online.
    c.sync();
    a.pull();
    expect(decide(a)).toBe("idle");
    a.push();
    c.pull();
    b.pull(() => false);
    expect([a, b, c].filter(holds)).toEqual([b]);
    syncAll([a, b, c]);
    for (const d of [a, b, c]) expect(view(d).pinned, d.name).toBe(b.id);
  });
});

describe("R4: automatic handover is an owner opt-in, only over a bounded transport", () => {
  it("cannot be opted into over a synced folder", async () => {
    const { a } = await devices([0, 0, 0], {
      mode: "pinned",
      visibility: visibilityOf("eventual"),
    });
    expect(() => pin(a, "auto", null)).toThrow(/bounded propagation/);
  });

  it("over a synced folder nobody holds in mode auto, even with a settled claim", async () => {
    const { a, b, c } = await devices([0, 0, 0], { visibility: visibilityOf("eventual") });
    expect(view(b).mode).toBe("auto");
    expect(step(b)).toBe("unsupported_transport");
    rawClaim(b); // written anyway (an old app, a bug): it reaches the chain
    b.push();
    for (let i = 0; i < 10; i++) {
      for (const d of [a, b, c]) d.sync();
      a.remote.time += MIN;
    }
    b.sync();
    expect(view(b).holder).toBe(b.id);
    expect(holds(b)).toBe(false);
    expect(step(b)).toBe("unsupported_transport");
    // The same device believing its folder were bounded would hold: the transport check decides.
    b.assumeBounded = true;
    expect(holds(b)).toBe(true);
  });

  it("a relay whose bound the config does not cover is unsupported", async () => {
    const { b } = await devices([0, 0, 0], {
      visibility: visibilityOf("bounded"),
      cfg: boundedConfig,
    });
    expect(nextLeaseStep(view(b), b.local(), true, boundedConfig).kind).toBe("claim");
    expect(nextLeaseStep(view(b), b.local(), true, config).kind).toBe("unsupported_transport");
  });

  it("the pinned leader acknowledges before the first automatic claim", async () => {
    const { a, b, c } = await devices([0, 0, 0], { mode: "pinned" });
    pin(b, "auto", null);
    syncAll([b, c]);
    expect(view(c)).toMatchObject({ mode: "auto", pendingFrom: a.id });
    expect(step(c)).toBe("handover_wait");
    const early = rawClaim(c);
    syncAll([b, c]);
    expect(reasonOf(b, early)).toBe("pending_handover");
    a.sync();
    expect(decide(a)).toBe("release");
    syncAll([a, b, c]);
    expect(view(c).pendingFrom).toBeNull();
    expect(step(c)).toBe("claim");
  });
});

// One schedule of each kind; the sweeps are lease.rule6.exhaustive.test.ts.
describe("R4: rule 6 on both backend kinds (one schedule each)", () => {
  it("auto over a bounded relay: never two holders, and someone holds", async () => {
    expect(await rule6Run(0, "bounded")).toMatchObject({ held: true, overlap: false });
  });

  it("auto over a synced folder: nobody holds; believing it bounded breaks rule 6 (control)", async () => {
    expect((await rule6Run(0, "eventual")).held).toBe(false);
    expect((await rule6Run(0, "eventual", true)).overlap).toBe(true);
  });

  it("pinned over a synced folder and over a relay, owner re-pins: never two holders", async () => {
    for (const backend of ["eventual", "bounded"] as const) {
      const r = await pinnedRun(0, backend, false);
      expect(r.overlaps).toBe(0);
      expect(r.leaders).toBeGreaterThan(1);
    }
  });

  it("S1: a staged backdated sibling pin over a synced folder: never two holders", async () => {
    // Schedule 7 is one where the old rule (earliest stamp wins) made two devices fetch.
    const r = await siblingRun(7);
    expect(r.overlaps).toBe(0);
    expect(r.acks).toBe(1); // the old leader handed over exactly once
  });

  it("S1b: the old leader retired after its hand-over, then a sibling pin: never two holders", async () => {
    const r = await siblingRun(0, true); // judging by today's trust made two devices fetch here
    expect(r.attacked).toBe(true);
    expect(r.overlaps).toBe(0);
  });

  it("forced re-pins: every overlap is a holder that has not seen the forced pin", async () => {
    expect((await pinnedRun(0, "eventual", true)).overlaps).toBeGreaterThan(0);
  });
});
