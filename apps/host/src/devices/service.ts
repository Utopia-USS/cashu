import { randomBytes } from "node:crypto";
import type {
  DeviceListParams,
  DeviceListResult,
  LeaderCommitParams,
  LeaderCommitResult,
  LeaderInspectParams,
  LeaderInspectResult,
  LeaderPreviewParams,
  LeaderPreviewResult,
  RevokeCancelParams,
  RevokeCancelResult,
  RevokeCommitParams,
  RevokeCommitResult,
  RevokeInspectParams,
  RevokeInspectResult,
  RevokePreviewParams,
  RevokePreviewResult,
} from "@cashu/host-protocol";
import { mintUlid } from "@cashu/store";
import type { NativeDeviceRevokeDraft, NativeVaultSession } from "../nativeVault.js";
import type { HostStores } from "../stores.js";

const PREVIEW_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 16;
const MAX_VAULT_PREVIEWS = 4;

interface Pending {
  readonly vault: string;
  readonly epoch: object;
  readonly session: NativeVaultSession;
  readonly draft: NativeDeviceRevokeDraft;
  readonly expiresAt: number;
}
interface PendingLeader {
  readonly vault: string;
  readonly session: NativeVaultSession;
  readonly epoch: object;
  readonly leader: string;
  readonly force: boolean;
  readonly head: string;
  readonly confirmationText: string;
  readonly operationId: string;
  readonly expiresAt: number;
}

export interface DeviceService {
  list(input: DeviceListParams): Promise<DeviceListResult>;
  preview(input: RevokePreviewParams): Promise<RevokePreviewResult>;
  commit(input: RevokeCommitParams): Promise<RevokeCommitResult>;
  inspect(input: RevokeInspectParams): Promise<RevokeInspectResult>;
  cancel(input: RevokeCancelParams): Promise<RevokeCancelResult>;
  leaderPreview(input: LeaderPreviewParams): Promise<LeaderPreviewResult>;
  leaderCommit(input: LeaderCommitParams): Promise<LeaderCommitResult>;
  leaderInspect(input: LeaderInspectParams): Promise<LeaderInspectResult>;
  pending(): number;
  close(): void;
}

export function createDeviceService(stores: HostStores, now: () => number): DeviceService {
  const pending = new Map<string, Pending>();
  const leaderPending = new Map<string, PendingLeader>();
  let closed = false;
  const live = (vault: string): NativeVaultSession | null => {
    if (closed) return null;
    const session = stores.vaults.get(vault)?.native;
    return session?.isCurrent() ? session : null;
  };
  const prune = () => {
    for (const [token, item] of pending) {
      if (
        item.expiresAt <= now() ||
        !item.session.isCurrent() ||
        stores.vaults.get(item.vault)?.native !== item.session
      )
        pending.delete(token);
    }
    for (const [token, item] of leaderPending)
      if (
        item.expiresAt <= now() ||
        !item.session.isCurrent() ||
        stores.vaults.get(item.vault)?.native !== item.session
      )
        leaderPending.delete(token);
  };
  const refused = (
    code: "unavailable" | "unknown_vault" | "preview_missing" | "preview_stale",
  ) => ({ kind: "refused" as const, code });
  const eid = () => mintUlid(now());
  return {
    async list(input) {
      const session = live(input.vault);
      return session ? session.deviceList() : refused("unknown_vault");
    },
    async preview(input) {
      prune();
      if (
        pending.size >= MAX_PREVIEWS ||
        [...pending.values()].filter((item) => item.vault === input.vault).length >=
          MAX_VAULT_PREVIEWS
      )
        return refused("unavailable");
      const session = live(input.vault);
      if (!session) return refused("unknown_vault");
      try {
        if (!session.isCurrent()) return refused("unavailable");
        const draft: NativeDeviceRevokeDraft = {
          vault: input.vault,
          targets: input.targets,
          recertify: input.recertify,
          operationId: eid(),
          eids: { revoke: eid(), rotate: eid() },
        };
        const result = await session.devicePreview(draft);
        if (result.kind !== "prepared") return result;
        prune();
        if (
          closed ||
          live(input.vault) !== session ||
          session.epoch !== stores.vaults.get(input.vault)?.native?.epoch
        )
          return refused("preview_stale");
        if (
          pending.size >= MAX_PREVIEWS ||
          [...pending.values()].filter((item) => item.vault === input.vault).length >=
            MAX_VAULT_PREVIEWS
        )
          return refused("unavailable");
        const token = randomBytes(16).toString("hex");
        const expiresAt = now() + PREVIEW_MS;
        pending.set(token, {
          vault: input.vault,
          epoch: session.epoch,
          session,
          draft: { ...draft, fingerprint: result.fingerprint },
          expiresAt,
        });
        return {
          kind: "prepared",
          vault: input.vault,
          token,
          operationId: draft.operationId,
          expiresAt,
          targets: [...result.targets],
          affected: [...result.affected],
          warning: "unseen_writes_possible",
          localStartConfirmationRequired: result.localStartConfirmationRequired,
        };
      } catch {
        return refused("unavailable");
      }
    },
    async commit(input) {
      const item = pending.get(input.token);
      pending.delete(input.token);
      prune();
      if (!item || item.vault !== input.vault) return refused("preview_missing");
      if (item.expiresAt <= now()) return { kind: "refused", code: "preview_expired" };
      if (item.epoch !== item.session.epoch || live(input.vault) !== item.session)
        return refused("preview_stale");
      try {
        return await item.session.deviceCommit(item.draft, {
          warningAcknowledgement: input.warningAcknowledgement,
          localStartAcknowledgement: input.localStartAcknowledgement,
          recoveryPhrase: input.recoveryPhrase,
        });
      } catch {
        return { kind: "outcome_unknown", operationId: item.draft.operationId };
      }
    },
    async inspect(input) {
      const session = live(input.vault);
      return session ? session.deviceInspect(input.operationId) : refused("unavailable");
    },
    async cancel(input) {
      const item = pending.get(input.token);
      if (item?.vault === input.vault) pending.delete(input.token);
      return { kind: "cancelled" };
    },
    async leaderPreview(input) {
      prune();
      if (
        leaderPending.size >= MAX_PREVIEWS ||
        [...leaderPending.values()].filter((item) => item.vault === input.vault).length >=
          MAX_VAULT_PREVIEWS
      )
        return refused("unavailable");
      const session = live(input.vault);
      if (!session) return refused("unknown_vault");
      const prepared = await session.leaderPrepare(input.leader, input.force);
      if (prepared.kind !== "prepared") return prepared;
      if (live(input.vault) !== session) return refused("preview_stale");
      const token = randomBytes(16).toString("hex");
      const operationId = eid();
      const expiresAt = now() + PREVIEW_MS;
      leaderPending.set(token, {
        vault: input.vault,
        session,
        epoch: session.epoch,
        leader: input.leader,
        force: input.force,
        head: prepared.head,
        confirmationText: prepared.confirmationText,
        operationId,
        expiresAt,
      });
      return {
        kind: "prepared",
        vault: input.vault,
        token,
        operationId,
        expiresAt,
        leader: input.leader,
        force: input.force,
        mayStillRun: prepared.mayStillRun,
        confirmationText: prepared.confirmationText,
      };
    },
    async leaderCommit(input) {
      const item = leaderPending.get(input.token);
      leaderPending.delete(input.token);
      prune();
      if (!item || item.vault !== input.vault) return refused("preview_missing");
      if (item.expiresAt <= now()) return { kind: "refused", code: "preview_expired" };
      if (item.session !== live(input.vault) || item.epoch !== item.session.epoch)
        return refused("preview_stale");
      if (input.confirmationText !== item.confirmationText)
        return { kind: "refused", code: "confirmation_required" };
      const result = await item.session.leaderCommit(
        item.leader,
        item.force,
        input.confirmationText,
        item.head,
        item.operationId,
      );
      return result === "not_started"
        ? { kind: "refused", code: "preview_stale" }
        : { kind: result, operationId: item.operationId };
    },
    async leaderInspect(input) {
      const session = live(input.vault);
      if (!session) return refused("unavailable");
      const result = await session.leaderInspect(input.operationId);
      return { kind: result, operationId: input.operationId };
    },
    pending() {
      prune();
      return pending.size + leaderPending.size;
    },
    close() {
      closed = true;
      pending.clear();
      leaderPending.clear();
    },
  };
}
