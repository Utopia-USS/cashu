import { expect, it } from "vitest";
import { buildLeasePin, pinConfirmationText } from "./events.js";
import { holdsLease } from "./lease.js";
import {
  advance,
  boundedConfig,
  decide,
  devices,
  holds,
  MIN,
  pin,
  reportFetch,
  tick,
  view,
  visibilityOf,
} from "./leaseSim.js";
import {
  hlcAt,
  newEid,
  prepareReviewedRevocation,
  type SimDevice,
  START_CURSOR,
} from "./testkit.js";

function sibling(d: SimDevice, leader: SimDevice, prev: string, wall: number): string {
  const eid = newEid();
  d.write(
    [
      buildLeasePin(
        d.identity,
        d.ring.vaultId,
        eid,
        { at: wall, watermark: {}, prev },
        {
          mode: "pinned",
          leader: leader.id,
          force: false,
          confirmation: { kind: "typed", text: pinConfirmationText("pinned", leader.id, false) },
        },
      ),
    ],
    { hlc: () => hlcAt(d.id, wall) },
  );
  return eid;
}

function invalidPin(d: SimDevice, leader: SimDevice, prev: string): string {
  const eid = newEid();
  d.write([
    buildLeasePin(
      d.identity,
      d.ring.vaultId,
      eid,
      { at: d.now(), watermark: {}, prev },
      {
        mode: "pinned",
        leader: leader.id,
        force: false,
        confirmation: { kind: "typed", text: "invalid confirmation" },
      },
    ),
  ]);
  return eid;
}

it("descendant release prevents a late sibling from restoring the old leader", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P, pending A
  b.sync();
  c.sync();
  expect(view(c).pendingFrom).toBe(a.id);
  pin(c, "pinned", b); // Q extends P, still pending A
  c.sync();
  a.sync();
  expect(view(a).pendingFrom).toBe(a.id);
  expect(decide(a)).toBe("release"); // ACK Q, not a direct child of P
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  // A stale P sibling, HLC before P, names A. B does not pull it.
  sibling(c, a, root, c.now() - 60_000);
  c.push();
  a.sync();
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("old leader's own descendant pin acknowledges the ancestor", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P
  b.sync();
  c.sync();
  pin(c, "pinned", a); // Q returns leadership to A
  c.sync();
  a.sync();
  expect(holds(a)).toBe(true);
  reportFetch(a); // F is a valid non-pin descendant while A leads
  pin(a, "pinned", b); // R: old leader itself transfers to B
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  sibling(c, a, root, c.now() - 60_000);
  c.push();
  a.sync();
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("return to old leader keeps the ancestor ordered by its later release", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P, pending A
  b.sync();
  c.sync();
  pin(c, "pinned", a); // Q, returns leadership to A
  c.sync();
  a.sync();
  expect(holds(a)).toBe(true);
  pin(c, "pinned", b); // R, pending A again
  c.sync();
  a.sync();
  expect(decide(a)).toBe("release");
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  sibling(c, a, root, c.now() - 60_000);
  c.push();
  a.sync();
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("a forced descendant does not supply an acknowledgement for its ancestor", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P
  b.sync();
  c.sync();
  pin(c, "pinned", b, { force: true }); // Q breaks A's pending handover
  c.sync();
  a.sync();
  pin(a, "pinned", b); // authenticated descendant, but A did not ACK P
  a.push();
  sibling(c, a, root, c.now() - 60_000);
  c.push();
  a.sync();
  expect(view(a).pinned).toBe(a.id); // earlier sibling wins without an ACK of P
});

it("an invalid predecessor cannot carry an acknowledgement to an ancestor", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P
  b.sync();
  c.sync();
  const invalid = invalidPin(c, b, view(c).head as string);
  c.push();
  a.sync();
  sibling(a, b, invalid, a.now()); // own pin below invalid Q must not ACK P
  a.push();
  sibling(c, a, root, c.now() - 60_000);
  c.push();
  a.sync();
  expect(view(a).pinned).toBe(a.id);
});

it("a post-cut release cannot acknowledge a pending pin", async () => {
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P, pending A
  b.push();
  a.sync();
  c.sync();
  const r = prepareReviewedRevocation(
    c,
    [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    recovery,
    { recertify: [b.id, c.id] },
  );
  if (!r.ok) throw new Error(r.reason);
  c.write(r.change.events);
  r.change.commit();
  c.push();
  expect(decide(a)).toBe("release"); // A has not seen its cut
  a.push();
  c.sync();
  expect(view(c).pendingFrom).toBe(a.id);
  sibling(c, b, root, c.now() - 60_000); // S wins without an authentic A ACK
  c.push();
  c.sync();
  expect(view(c).pinned).toBe(b.id);
});

it("a fetched prefix of an acknowledged handover resists a late root pin", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(a).head as string;
  expect(holds(a)).toBe(true);
  reportFetch(a); // F, a valid non-pin child of root
  a.push();
  pin(a, "pinned", b); // P, own acknowledged handover below F
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  sibling(c, a, root, c.now() - 60_000); // S, late sibling of F
  c.push();
  a.sync();
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("a release prefix of an acknowledged handover resists a late pin", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  pin(b, "pinned", b); // P, pending A
  b.push();
  a.sync();
  const pending = view(a).head as string;
  expect(decide(a)).toBe("release"); // L directly acknowledges P
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  sibling(c, a, pending, c.now() - 60_000); // S races L below P
  c.push();
  a.sync();
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("an auto holder cannot leave auto through a fetched prefix without force", async () => {
  const { a, b, c, remote } = await devices();
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  expect(tick(a)).toBe("claim");
  advance(a, 8 * MIN);
  a.sync();
  expect(holds(a)).toBe(true);
  reportFetch(a);
  a.push();
  const fetched = view(a).head as string;
  expect(() => pin(a, "pinned", b)).toThrow("owner-confirmed force");
  const rejected = sibling(a, b, fetched, a.now());
  a.push();
  b.sync();
  a.sync();
  expect(view(a).ignored.find((x) => x.eid === rejected)?.reason).toBe("force_required");
  expect([a, b, c].filter(holds)).toHaveLength(1);
});

it("a retired old leader's pre-cut ACK protects an auto claim from a late sibling pin", async () => {
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], {
    mode: "pinned",
    visibility: visibilityOf("bounded"),
    cfg: boundedConfig,
  });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  pin(b, "auto", null, { cfg: boundedConfig }); // P, pending A
  b.push();
  a.sync();
  const pending = view(a).head as string;
  expect(decide(a, true, boundedConfig)).toBe("release"); // L, pre-cut
  a.push();
  b.sync();
  expect(decide(b, true, boundedConfig)).toBe("claim"); // K
  b.push();
  advance(a, 10 * MIN);
  b.sync();
  const autoHolds = (d: SimDevice) => holdsLease(view(d), d.local(), boundedConfig);
  expect(autoHolds(b)).toBe(true);
  c.sync();
  const r = prepareReviewedRevocation(
    c,
    [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    recovery,
    { recertify: [b.id, c.id] },
  );
  if (!r.ok) throw new Error(r.reason);
  c.write(r.change.events);
  r.change.commit();
  c.push();
  sibling(c, c, pending, c.now() - 60_000); // S, stale sibling of L
  c.push();
  c.sync();
  expect([b, c].filter(autoHolds)).toHaveLength(1);
});

it("a pin after old leader revocation waits until force, then waits for the new leader", async () => {
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  pin(b, "pinned", b); // P waits for A
  b.push();
  c.sync();
  const r = prepareReviewedRevocation(
    c,
    [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    recovery,
    { recertify: [b.id, c.id] },
  );
  if (!r.ok) throw new Error(r.reason);
  c.write(r.change.events);
  r.change.commit();
  c.push();
  b.sync();
  expect(view(b).pendingFrom).toBe(a.id);
  expect(holds(b)).toBe(false);
  pin(b, "pinned", b, { force: true }); // explicit recovery from the lost predecessor
  b.push();
  c.sync();
  expect(holds(b)).toBe(true);
  pin(c, "pinned", c); // Q must wait for B, not revoked A
  c.sync();
  expect(view(c).pendingFrom).toBe(b.id);
  expect(holds(c)).toBe(false);
  expect(holds(b)).toBe(true);
  b.sync();
  expect(holds(b)).toBe(false);
  expect(decide(b)).toBe("release");
  b.push();
  c.sync();
  expect(holds(c)).toBe(true);
});

it("a descendant pre-cut ACK stays stable after revoking the old leader", async () => {
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  const root = view(b).head as string;
  pin(b, "pinned", c); // P pending A
  b.sync();
  c.sync();
  pin(c, "pinned", b); // Q still pending A
  c.sync();
  a.sync();
  expect(decide(a)).toBe("release"); // A pre-cut ACK Q
  a.push();
  b.sync();
  expect(holds(b)).toBe(true);
  c.sync();
  const r = prepareReviewedRevocation(
    c,
    [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    recovery,
    { recertify: [b.id, c.id] },
  );
  if (!r.ok) throw new Error(r.reason);
  c.write(r.change.events);
  r.change.commit();
  c.push();
  sibling(c, c, root, c.now() - 60_000); // stale sibling of P
  c.push();
  c.sync();
  expect([b, c].filter(holds)).toHaveLength(1);
});

it("no-ACK revocation with two unseen sibling pins never creates two holders", async () => {
  const { a, b, c, remote, recovery } = await devices([0, 0, 0], { mode: "pinned" });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  pin(b, "pinned", b); // P is local to B; C has not seen it
  const r = prepareReviewedRevocation(
    c,
    [{ device: a.id, cut: c.cursors.get(a.id) ?? START_CURSOR }],
    { revoke: newEid(), rotate: newEid(), recertify: newEid },
    recovery,
    { recertify: [b.id, c.id] },
  );
  if (!r.ok) throw new Error(r.reason);
  c.write(r.change.events);
  r.change.commit();
  c.push();
  b.sync(); // B sees its P and A's revocation; C has not seen P
  expect(view(b).pendingFrom).toBe(a.id);
  expect(holds(b)).toBe(false);
  pin(c, "pinned", c); // S is a sibling of P, based on C's root view
  c.push();
  expect(view(c).pendingFrom).toBe(a.id);
  expect([b, c].filter(holds)).toHaveLength(0);
});

it("a stale auto-free view cannot pin over a settled claim without force", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], {
    visibility: visibilityOf("bounded"),
    cfg: boundedConfig,
  });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  expect(decide(b, true, boundedConfig)).toBe("claim");
  b.push();
  advance(a, 10 * MIN);
  b.sync();
  const autoHolds = (d: SimDevice) => holdsLease(view(d), d.local(), boundedConfig);
  expect(autoHolds(b)).toBe(true);
  const oldHead = view(c).head as string;
  expect(() => pin(c, "pinned", c)).toThrow("owner-confirmed force");
  const rejected = sibling(c, c, oldHead, c.now()); // raw signed event from stale client
  c.push();
  c.sync();
  expect(view(c).ignored.find((x) => x.eid === rejected)?.reason).toBe("force_required");
  expect([b, c].filter(autoHolds)).toHaveLength(1);
  pin(c, "pinned", c, { force: true });
  c.push();
  c.sync();
  expect(autoHolds(c)).toBe(true); // explicit force permits a brief overlap
});

it("a stale expired auto holder cannot hand over against a settled successor without force", async () => {
  const { a, b, c, remote } = await devices([0, 0, 0], {
    visibility: visibilityOf("bounded"),
    cfg: boundedConfig,
  });
  remote.flush();
  for (const d of [a, b, c]) d.sync();
  expect(decide(a, true, boundedConfig)).toBe("claim");
  a.push();
  advance(a, 10 * MIN);
  for (const d of [a, b, c]) d.sync();
  const oldHead = view(c).head;
  advance(a, 65 * MIN);
  b.sync();
  expect(decide(b, true, boundedConfig)).toBe("claim");
  b.push();
  advance(a, 10 * MIN);
  b.sync();
  const autoHolds = (d: SimDevice) => holdsLease(view(d), d.local(), boundedConfig);
  expect(autoHolds(b)).toBe(true);
  expect(view(c).head).toBe(oldHead); // C still knows only expired A term
  expect(() => pin(c, "pinned", c)).toThrow("owner-confirmed force");
  const rejected = sibling(c, c, oldHead as string, c.now());
  c.push();
  a.sync();
  c.sync();
  expect(view(c).ignored.find((x) => x.eid === rejected)?.reason).toBe("force_required");
  expect([b, c].filter(autoHolds)).toHaveLength(1);
});
