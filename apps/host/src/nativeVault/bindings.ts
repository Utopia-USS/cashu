// Exact-session authorities handed to other host parts: workspace files, the strategy folder, merge
// checkpoints, the encrypted import archive and live public-market fetches. Each is invalid once
// this session is no longer current.
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { backupNodeSqlite } from "@cashu/node-host/sqlite";
import { NativeBlobPublication } from "../nativeBlobs.js";
import { createNativeCheckpoint } from "../nativeCheckpoint.js";
import { readNativeRecoveryWrap } from "../nativeCreationArtifacts.js";
import type { NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";
import { pairingAuthority } from "./pairing.js";
import { existing } from "./paths.js";
import type { NativeVaultSession } from "./types.js";

type Bindings = Pick<
  NativeVaultSession,
  | "workspaceAuthority"
  | "createMergeCheckpoint"
  | "checkpointDirectory"
  | "strategyDirectoryAuthority"
  | "beginFetch"
  | "blobPublication"
> & {
  /** Closes the import archive, if one was opened (on invalidate and close). */
  closeBlobPublication(): void;
};

export function sessionBindings(
  context: NativeVaultContext,
  guards: Pick<SessionGuards, "isCurrent" | "canRunSideEffects" | "canFetchPublicMarket">,
): Bindings {
  const { entry, dataDir, root, source, lease, meta, store, candidate, certificates, state } =
    context;
  const { isCurrent, canRunSideEffects, canFetchPublicMarket } = guards;
  const workspaceGeneration = randomUUID();
  let blobPublication: NativeBlobPublication | null = null;
  return {
    workspaceAuthority: () => {
      if (!canRunSideEffects()) return null;
      const fingerprint = pairingAuthority(context);
      return {
        vault: entry.vaultId,
        generation: `${workspaceGeneration}:${fingerprint}`,
        isCurrent: () => canRunSideEffects() && pairingAuthority(context) === fingerprint,
      };
    },
    createMergeCheckpoint: async () => {
      if (!canRunSideEffects()) throw new Error("native_checkpoint_unavailable");
      await createNativeCheckpoint({
        root,
        vault: entry.vaultId,
        device: entry.deviceId,
        sodium: source.sodium,
        ring: candidate.ring,
        identity: candidate.identity,
        baseRecoveryWrap: readNativeRecoveryWrap(dataDir, entry.vaultId),
        certificates,
        frontier: () => JSON.stringify([...store.cursors()].sort(([a], [b]) => a.localeCompare(b))),
        isCurrent: canRunSideEffects,
        backupDatabase: (name, destination) =>
          backupNodeSqlite(name === "private.db" ? meta : store.driver, destination),
      });
    },
    checkpointDirectory: () => join(root, "checkpoints"),
    strategyDirectoryAuthority: () => {
      if (!isCurrent()) return null;
      try {
        const rootInfo = lstatSync(root);
        const directory = existing(join(root, "strategy"), "directory");
        const strategyInfo = lstatSync(directory);
        if (
          !rootInfo.isDirectory() ||
          rootInfo.isSymbolicLink() ||
          (rootInfo.mode & 0o077) !== 0 ||
          (strategyInfo.mode & 0o077) !== 0
        )
          return null;
        return { vault: entry.vaultId, privateRoot: root, directory, isCurrent };
      } catch (error) {
        // A vault without a strategy folder yet is the expected case; any other cause is traced.
        if (!(error instanceof Error && error.message === "native_vault_unavailable"))
          warnCause("native_strategy_directory_unavailable", error);
        return null;
      }
    },
    beginFetch: () => {
      if (!canFetchPublicMarket()) return null;
      state.activeFetches++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        state.activeFetches--;
      };
    },
    blobPublication: () => {
      if (!isCurrent()) return null;
      if (blobPublication === null)
        blobPublication = new NativeBlobPublication({
          dataDir,
          vault: entry.vaultId,
          lock: lease.lock(),
          sodium: source.sodium,
          ring: candidate.ring,
        });
      return blobPublication.isCurrent() ? blobPublication : null;
    },
    closeBlobPublication: () => blobPublication?.close(),
  };
}
