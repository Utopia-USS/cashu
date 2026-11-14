/** Existing local queue claims precede OS delivery; no notifier transport or permission bypass. */
import { DEFAULT_NOTIFICATIONS, isoNumber } from "@cashu/domain/investments/strategy";
import {
  type NotificationQueue,
  notificationDisposition,
  type QueuedNotification,
} from "@cashu/store/investments/local";
import { workerNotificationState } from "@cashu/store/investments/queries";
import { loadStrategy } from "@cashu/store/investments/services";
import type { OpenVault } from "../stores.js";
import { WorkerAuthorityLost } from "./authority.js";
import type {
  JobOutcome,
  WorkerBindings,
  WorkerNotification,
  WorkerNotificationResult,
  WorkerNotifier,
  WorkerState,
} from "./contracts.js";
import { localDay } from "./schedule.js";

interface NotificationDeps {
  readonly vault: OpenVault;
  readonly bindings: WorkerBindings;
  readonly notifier: WorkerNotifier;
  readonly queue: NotificationQueue;
  readonly now: () => number;
  readonly guard: () => void;
}
/** A thrown adapter cannot prove whether submission occurred. Keep the exact queue claim. */
async function attempt(
  notifier: WorkerNotifier,
  notification: WorkerNotification,
): Promise<WorkerNotificationResult> {
  try {
    return await notifier.send(notification);
  } catch {
    return { state: "unknown" };
  }
}
async function policy(deps: Pick<NotificationDeps, "bindings" | "vault" | "guard">) {
  deps.guard();
  const files = deps.bindings.investments?.files(deps.vault);
  if (files === undefined || files === null) throw new WorkerAuthorityLost();
  const state = await loadStrategy(deps.vault.store, files);
  deps.guard();
  return state.config?.notifications ?? DEFAULT_NOTIFICATIONS;
}
export async function deliverWorkerNotifications(deps: NotificationDeps): Promise<JobOutcome> {
  const { vault, queue, notifier } = deps;
  const guard = () => deps.guard(),
    now = () => new Date(deps.now()).toISOString();
  const locale = deps.bindings.language(vault);
  const work = <T>(read: () => T) =>
    vault.queue.run(() => {
      guard();
      return read();
    });
  const rows = await work(() => queue.pending(vault.id));
  guard();
  const stats = { delivered: 0, summarized: 0, skipped: 0, failed: 0, unknown: 0 };
  const currentPolicy = await policy(deps);
  const examine = (row: QueuedNotification, channel?: string, claimedAt?: string) =>
    work(() => {
      const read = vault.store.read.bind(vault.store),
        facts = workerNotificationState(read, row.signal, row.createdAt);
      const disposition = notificationDisposition(
        row,
        facts?.state,
        now(),
        currentPolicy.immediate,
      );
      if (disposition === "wait") return undefined;
      if (disposition === "discard") {
        const state = facts?.state;
        const reason = state?.hidden
          ? "hidden"
          : state?.status !== "active" && state?.status !== "acknowledged"
            ? "closed"
            : state?.status === "acknowledged"
              ? "acknowledged"
              : state?.decided
                ? "decided"
                : "policy";
        if (queue.claim(vault.id, row.id, now(), `skipped:${reason}`)) stats.skipped++;
        return undefined;
      }
      if (channel !== undefined && !queue.claim(vault.id, row.id, claimedAt ?? now(), channel))
        return undefined;
      return facts !== undefined;
    });
  const due: QueuedNotification[] = [];
  for (const row of rows) {
    if ((await examine(row)) === true) due.push(row);
    guard();
  }
  for (const row of due.slice(0, 3)) {
    const claimedAt = now(),
      present = await examine(row, notifier.name, claimedAt);
    // If authority is lost after the durable claim but before submit, leave the claim retained.
    // Releasing it here could duplicate a concurrent or uncertain OS attempt.
    guard();
    if (present !== true) continue;
    const delivered = await attempt(notifier, {
      vaultId: vault.id,
      kind: "signal",
      signalId: row.signal,
      locale,
    });
    guard();
    if (delivered.state === "rejected") {
      await work(() => queue.release(vault.id, row.id, claimedAt));
      stats.failed++;
      return {
        status: stats.delivered === 0 ? "failed" : "partial",
        code: "notification_failed",
        stats,
      };
    }
    if (delivered.state === "unknown") stats.unknown++;
    else stats.delivered++;
  }
  const claimed: { row: QueuedNotification; at: string }[] = [];
  for (const row of due.slice(3)) {
    const at = now();
    if ((await examine(row, `${notifier.name}:summary`, at)) === true) claimed.push({ row, at });
    guard();
  }
  if (claimed.length !== 0) {
    const result = await attempt(notifier, {
      vaultId: vault.id,
      kind: "signalsSummary",
      locale,
    });
    guard();
    if (result.state === "rejected") {
      for (const item of claimed) await work(() => queue.release(vault.id, item.row.id, item.at));
      stats.failed = claimed.length;
    } else if (result.state === "unknown") stats.unknown += claimed.length;
    else stats.summarized = claimed.length;
  }
  return {
    status:
      stats.failed === 0
        ? stats.unknown === 0
          ? "ok"
          : "partial"
        : stats.delivered === 0
          ? "failed"
          : "partial",
    stats,
  };
}

export async function sendWorkerDigest(
  deps: Omit<NotificationDeps, "queue"> & {
    readonly state: WorkerState;
    readonly save: () => Promise<void>;
  },
): Promise<JobOutcome> {
  const { vault } = deps;
  const guard = () => deps.guard();
  const time = deps.now(),
    day = localDay(time);
  const currentPolicy = await policy(deps);
  if ((new Date(time).getDay() || 7) !== isoNumber(currentPolicy.digestWeekday))
    return { status: "skipped", code: "digest_not_due" };
  if (deps.state.digests[vault.id] === day)
    return { status: "skipped", code: "digest_already_sent" };
  const previous = deps.state.digests[vault.id];
  deps.state.digests[vault.id] = day;
  await deps.save();
  // The marker remains if authority disappears before submit; reconciliation is explicit.
  guard();
  const result = await attempt(deps.notifier, {
    vaultId: vault.id,
    kind: "reviewDigest",
    locale: deps.bindings.language(vault),
  });
  guard();
  if (result.state === "rejected") {
    if (previous === undefined) delete deps.state.digests[vault.id];
    else deps.state.digests[vault.id] = previous;
    await deps.save();
  }
  return {
    status: result.state === "accepted" ? "ok" : result.state === "unknown" ? "partial" : "failed",
    ...(result.state === "rejected" ? { code: "digest_failed" } : {}),
    stats: { unknown: result.state === "unknown" ? 1 : 0 },
  };
}
