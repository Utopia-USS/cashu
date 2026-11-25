// Relay membership of revoked devices (M4 revocation): once the revocation batch reached the relay, the
// revoked device's membership (`members/{uid}`) is removed, so it cannot read anything the vault writes
// later. The membership goes only AFTER the push: a phone still able to pull reads its own revocation
// and says so ("This phone was removed ..."), instead of only meeting a refusal.
//
// "Pushed" = a relay pass of this vault completed after the device change that first showed the
// device revoked was signalled (the relay's `lastSyncAt` passed that time; a pass pushes every own
// frame, the revocation included). A removal the relay refuses or cannot take is retried after every
// later pass (the session's device-change signal fires after each), counted in `failing()` and shown in
// the relay status (`removalsFailing`: how many, since when, which devices); it is never dropped.
//
// The same sweep reconciles the relay's member list with the vault (`reconcile`): the convergence of
// the pairing commit point (service.ts).
import { relayMemberUid, relaySetting } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { NativeVaultSession } from "../nativeVault.js";
import type { HostRelay } from "../relay/service.js";
import type { HostStores } from "../stores.js";

/** The relay uid bound to each device of a vault on this Mac (its relay setting); none: empty. */
export function relayMemberUids(
  stores: () => HostStores | undefined,
): (vault: string) => Readonly<Record<string, string>> {
  return (vault) => {
    const device = stores()?.device.store;
    if (device === undefined) return {};
    try {
      const setting = runQuery(device, relaySetting, { vault }).value;
      if (setting === null) return {};
      return Object.fromEntries(
        Object.entries(setting.memberUids).map(([id, entry]) => [id, relayMemberUid(entry)]),
      );
    } catch {
      return {};
    }
  };
}

/**
 * How long a member document nothing explains stays before it is removed: 7 days. A second Mac that
 * admitted a phone writes the membership first and pushes its device.added right after (retrying that
 * push), but when that Mac goes offline (closed lid, travel, a relay outage on its side) in between,
 * the device.added reaches the relay only when it is back, so here the membership looks unexplained
 * for as long as that Mac stays away. An hour would remove a phone the other Mac really paired; 7 days
 * matches the fetch lease's offline bound (lease.ts OFFLINE_LEAD_MAX_MS), the time we already assume a
 * second Mac can be away. Removing too late keeps a leftover document a few days longer; removing too
 * early cuts a really paired phone off its sync.
 */
const STRAY_GRACE_MS = 7 * 24 * 60 * 60_000;

export interface MemberSweep {
  /** Revoked devices whose membership could not be removed yet, per vault (0 when none). */
  failing(vault: string): number;
  close(): void;
}

type SweepRelay = Pick<
  HostRelay,
  | "status"
  | "removeMember"
  | "listMembers"
  | "removeStrayMember"
  | "adoptMembers"
  | "noteRemovalsFailing"
  | "pruneExpiredPairings"
>;

/** Grace past a pairing session's end before a leftover one is deleted (service.ts RETIRE_GRACE_MS). */
const LEFTOVER_SESSION_GRACE_MS = 60_000;

export function startMemberSweep(input: {
  readonly stores: HostStores;
  readonly relay: SweepRelay;
  /** The relay uid bound to each device of the vault (the relay setting's memberUids). */
  readonly memberUids: (vault: string) => Readonly<Record<string, string>>;
  readonly now: () => number;
  readonly warn: (event: string, error: unknown) => void;
}): MemberSweep {
  const { stores, relay, now, warn } = input;
  /** `${vault}:${device}` -> when this Mac first saw the device revoked while it was still bound. */
  const seen = new Map<string, number>();
  /**
   * Per vault: the revoked devices whose removal failed, each with the time its removal first failed
   * (kept while it keeps failing), and since when removals fail at all.
   */
  const failures = new Map<
    string,
    { readonly devices: ReadonlyMap<string, number>; readonly since: number }
  >();
  /** `${vault}:${uid}` -> when a member document nothing explains was first listed. */
  const strays = new Map<string, number>();
  /** Per vault: the relay pass (its `lastSyncAt`) the last reconciliation attempt followed. */
  const reconciledAfter = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  /** A signal that came while a sweep ran, with its time. */
  const again = new Map<string, number>();
  const unsubscribe: (() => void)[] = [];
  let closed = false;

  const report = (vault: string, failed: ReadonlySet<string>) => {
    const previous = failures.get(vault);
    if (failed.size === 0) failures.delete(vault);
    else {
      const at = now();
      failures.set(vault, {
        devices: new Map(
          [...failed].map((device) => [device, previous?.devices.get(device) ?? at]),
        ),
        since: previous?.since ?? at,
      });
    }
    const current = failures.get(vault);
    relay.noteRemovalsFailing(
      vault,
      current === undefined
        ? undefined
        : {
            devices: current.devices.size,
            since: current.since,
            // The longest failing first (the status line names that one), ties by id.
            ids: [...current.devices]
              .sort(([a, at], [b, bt]) => at - bt || a.localeCompare(b))
              .map(([device]) => device),
          },
    );
  };

  /** Revoked devices lose their membership once their revocation reached the relay. */
  const removeRevoked = async (
    vault: string,
    session: NativeVaultSession,
    signalAt: number,
  ): Promise<void> => {
    const bound = input.memberUids(vault);
    const own = session.device;
    if (!Object.keys(bound).some((device) => device !== own)) {
      report(vault, new Set());
      return;
    }
    if (!relay.status(vault).enabled) return;
    const list = await session.deviceList();
    if (list.kind !== "ready") return;
    // Read after the list: the signal fires as a pass settles, and the relay records the pass's time
    // just after it (a sweep is also started a turn later, see `schedule`).
    const status = relay.status(vault);
    const failed = new Set<string>();
    for (const device of list.devices) {
      if (!device.revoked || device.id === own || bound[device.id] === undefined) continue;
      const key = `${vault}:${device.id}`;
      const since = seen.get(key);
      if (since === undefined) {
        seen.set(key, signalAt);
        continue;
      }
      if ((status.lastSyncAt ?? Number.NEGATIVE_INFINITY) <= since) continue;
      try {
        await relay.removeMember(vault, device.id);
        seen.delete(key);
      } catch (error) {
        failed.add(device.id);
        warn("pairing.member-removal-failed", error);
      }
    }
    report(vault, failed);
  };

  /**
   * The relay's member list against the device registry and the pairing journal (the pairing commit
   * point's convergence, service.ts): an `admitting` row is resolved by whether its member document
   * exists, an owed append is retried, the setting adopts what the list says (roles, a lost binding),
   * and a member document that no registered device and no live row explains is removed once it stayed
   * so for STRAY_GRACE_MS and a relay pass completed after that (a second Mac's device.added may still
   * be on its way).
   * Runs after the open pass and every later relay pass that reached the relay (never while it is out).
   */
  const reconcile = async (vault: string, session: NativeVaultSession): Promise<void> => {
    // Only after a pass of this run reached the relay (the open pass first, then every later one): a
    // vault whose sync is off, or a relay that is out, is never asked here.
    const status = relay.status(vault);
    const lastPass = status.lastSyncAt;
    if (!status.enabled || lastPass === undefined || reconciledAfter.get(vault) === lastPass)
      return;
    if (!reconciledAfter.has(vault))
      // Once after the open pass: pairing sessions a crash left at the relay.
      void relay
        .pruneExpiredPairings(vault, LEFTOVER_SESSION_GRACE_MS)
        .catch((error: unknown) => warn("pairing.prune-failed", error));
    reconciledAfter.set(vault, lastPass);
    const listedAt = now();
    let members: Awaited<ReturnType<SweepRelay["listMembers"]>>;
    try {
      members = await relay.listMembers(vault);
    } catch (error) {
      // Sync never enabled here (relay_off) or the relay is out: the next pass retries.
      if (!(error instanceof Error && error.message === "relay_off"))
        warn("pairing.member-list-failed", error);
      return;
    }
    const known = await session.pairingAdmissions(members.map((member) => member.device));
    if (known === undefined) return;
    let owed = false;
    for (const row of known.live) {
      if (row.phase === "may_append") {
        owed = true;
        continue;
      }
      if (row.phase !== "admitting") continue;
      const present = members.some((m) => m.uid === row.uid && m.device === row.device);
      await session.pairingResolve(row.session, present ? "present" : "absent", listedAt);
    }
    if (owed) await session.pairingResume();
    // Read again: a resolution just appended a device.added.
    const after = await session.pairingAdmissions(members.map((member) => member.device));
    if (after === undefined) return;
    const liveUids = new Set(after.live.map((row) => row.uid));
    const liveDevices = new Set(after.live.map((row) => row.device));
    const listed = new Set<string>();
    for (const member of members) {
      // Only phones: an admin is a Mac (this one, or a second one that manages its own).
      if (member.role !== "member" || member.device === session.device) continue;
      const key = `${vault}:${member.uid}`;
      listed.add(key);
      if (
        after.registered.has(member.device) ||
        liveUids.has(member.uid) ||
        liveDevices.has(member.device)
      ) {
        strays.delete(key);
        continue;
      }
      const first = strays.get(key);
      if (first === undefined) {
        strays.set(key, listedAt);
        continue;
      }
      // Still unexplained after the grace, by a list that followed a pass completed after it.
      if (
        listedAt < first + STRAY_GRACE_MS ||
        (relay.status(vault).lastSyncAt ?? Number.NEGATIVE_INFINITY) <= first + STRAY_GRACE_MS
      )
        continue;
      try {
        await relay.removeStrayMember(vault, member.uid);
        strays.delete(key);
        warn("pairing.stray-member-removed", undefined);
      } catch (error) {
        warn("pairing.stray-member-removal-failed", error);
      }
    }
    for (const key of [...strays.keys()])
      if (key.startsWith(`${vault}:`) && !listed.has(key)) strays.delete(key);
    await relay
      .adoptMembers(vault, members, after.registered)
      .catch((error: unknown) => warn("pairing.member-adopt-failed", error));
  };

  /** `signalAt`: when the device change was signalled (a revocation is seen no later than that). */
  const sweep = async (vault: string, signalAt: number): Promise<void> => {
    const session = stores.vaults.get(vault)?.native;
    if (session === undefined || closed) return;
    await removeRevoked(vault, session, signalAt);
    if (closed) return;
    await reconcile(vault, session);
  };

  const schedule = (vault: string, signalAt = now()): void => {
    if (closed) return;
    if (running.has(vault)) {
      if (!again.has(vault)) again.set(vault, signalAt);
      return;
    }
    // A turn later: the signal of a settling pass comes before the relay recorded that pass.
    const pass = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => sweep(vault, signalAt))
      .catch((error: unknown) => warn("pairing.member-sweep-failed", error))
      .finally(() => {
        running.delete(vault);
        const next = again.get(vault);
        again.delete(vault);
        if (next !== undefined) schedule(vault, next);
      });
    running.set(vault, pass);
  };

  for (const [vault, opened] of stores.vaults) {
    const session = opened.native;
    if (session === undefined) continue;
    unsubscribe.push(session.onDevicesChanged(() => schedule(vault)));
    schedule(vault);
  }

  return {
    failing: (vault) => failures.get(vault)?.devices.size ?? 0,
    close() {
      closed = true;
      for (const stop of unsubscribe.splice(0)) stop();
    },
  };
}
