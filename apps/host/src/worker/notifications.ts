/** Existing local queue claims precede OS delivery; no notifier transport or permission bypass. */
import { DEFAULT_NOTIFICATIONS, isoNumber } from "@cashu/domain/investments/strategy";
import { createTranslator } from "@cashu/i18n";
import { mcpProfile } from "@cashu/store/core";
import {
  type NotificationQueue,
  notificationDisposition,
  type QueuedNotification,
} from "@cashu/store/investments/local";
import { workerNotificationState, workerReviewCount } from "@cashu/store/investments/queries";
import { loadStrategy } from "@cashu/store/investments/services";
import type { OpenVault } from "../stores.js";
import { WorkerAuthorityLost } from "./authority.js";
import type { JobOutcome, WorkerBindings, WorkerNotifier, WorkerState } from "./contracts.js";
import { localDay } from "./schedule.js";
import { S } from "./worker.strings.js";

interface NotificationDeps {
  readonly vault: OpenVault;
  readonly bindings: WorkerBindings;
  readonly notifier: WorkerNotifier;
  readonly queue: NotificationQueue;
  readonly now: () => number;
  readonly guard: () => void;
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
  const t = createTranslator(deps.bindings.language(vault));
  const work = <T>(read: () => T) =>
    vault.queue.run(() => {
      guard();
      return read();
    });
  const profile = await work(() => mcpProfile(vault.store.read.bind(vault.store)));
  guard();
  const title = t.tr(S.title)(profile?.name || profile?.slug || "");
  const rows = await work(() => queue.pending(vault.id));
  guard();
  const stats = { delivered: 0, summarized: 0, skipped: 0, failed: 0 };
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
      return facts?.message;
    });
  const due: QueuedNotification[] = [];
  for (const row of rows) {
    if ((await examine(row)) !== undefined) due.push(row);
    guard();
  }
  for (const row of due.slice(0, 3)) {
    const claimedAt = now(),
      message = await examine(row, notifier.name, claimedAt);
    guard();
    if (message === undefined) continue;
    const url = deps.bindings.notificationUrl?.(vault, row.signal);
    const delivered = await notifier.send({
      title,
      subtitle: t.tr(
        row.severity === "action" ? S.action : row.severity === "info" ? S.info : S.signal,
      ),
      message,
      group: `cashu-signal-${row.signal}`,
      ...(url === undefined ? {} : { url }),
    });
    guard();
    if (!delivered.ok) {
      await work(() => queue.release(vault.id, row.id, claimedAt));
      stats.failed++;
      return {
        status: stats.delivered === 0 ? "failed" : "partial",
        code: "notification_failed",
        stats,
      };
    }
    stats.delivered++;
  }
  const claimed: { row: QueuedNotification; at: string }[] = [];
  for (const row of due.slice(3)) {
    const at = now();
    if ((await examine(row, `${notifier.name}:summary`, at)) !== undefined)
      claimed.push({ row, at });
    guard();
  }
  if (claimed.length !== 0) {
    const url = deps.bindings.notificationUrl?.(vault, "investments");
    const result = await notifier.send({
      title,
      subtitle: t.tr(S.newSignals),
      message: t.tr(S.more)(claimed.length),
      group: `cashu-signals-${vault.id}`,
      ...(url === undefined ? {} : { url }),
    });
    guard();
    if (result.ok) stats.summarized = claimed.length;
    else {
      for (const item of claimed) await work(() => queue.release(vault.id, item.row.id, item.at));
      stats.failed = claimed.length;
    }
  }
  return {
    status: stats.failed === 0 ? "ok" : stats.delivered === 0 ? "failed" : "partial",
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
    day = localDay(time),
    t = createTranslator(deps.bindings.language(vault));
  const currentPolicy = await policy(deps);
  const facts = await vault.queue.run(() => {
    guard();
    const read = vault.store.read.bind(vault.store);
    return {
      profile: mcpProfile(read),
      count: workerReviewCount(read, new Date(time).toISOString()),
    };
  });
  guard();
  if ((new Date(time).getDay() || 7) !== isoNumber(currentPolicy.digestWeekday))
    return { status: "skipped", code: "digest_not_due" };
  if (deps.state.digests[vault.id] === day)
    return { status: "skipped", code: "digest_already_sent" };
  const previous = deps.state.digests[vault.id];
  deps.state.digests[vault.id] = day;
  await deps.save();
  guard();
  const url = deps.bindings.notificationUrl?.(vault, "review");
  const result = await deps.notifier.send({
    title: t.tr(S.title)(facts.profile?.name || facts.profile?.slug || ""),
    subtitle: t.tr(S.weekly),
    message: t.tr(S.digest)(facts.count),
    group: `cashu-digest-${vault.id}`,
    ...(url === undefined ? {} : { url }),
  });
  guard();
  if (!result.ok) {
    if (previous === undefined) delete deps.state.digests[vault.id];
    else deps.state.digests[vault.id] = previous;
    await deps.save();
  }
  return {
    status: result.ok ? "ok" : "failed",
    ...(result.ok ? {} : { code: "digest_failed" }),
    stats: { signals: facts.count },
  };
}
