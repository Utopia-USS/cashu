import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HostLock } from "@cashu/node-host";
import { type DurableCommandResult, defineCommand, mintUlid, ok, refuse } from "@cashu/store";
import { z } from "zod";
import { runHostVaultCommand } from "./commands.js";
import type { ConnectorCatalog } from "./connectors/catalog.js";
import { deletionOnlyConnectorSecrets } from "./connectors/secrets.js";
import { readExistingNativeInventory } from "./nativeInventory.js";
import type { HostStores, OpenVault } from "./stores.js";

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const markerSchema = z.strictObject({
  id: idSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z
    .array(
      z.strictObject({
        vault: z.string().regex(/^[a-f0-9]{32}$/),
        gids: z.array(z.string().min(1).max(128)).max(100),
      }),
    )
    .max(100),
  pending: z.nullable(
    z.strictObject({ vault: z.string().regex(/^[a-f0-9]{32}$/), key: z.string().min(1).max(128) }),
  ),
});
type Marker = z.infer<typeof markerSchema>;
type Result =
  | {
      readonly status: "completed";
      readonly value: { readonly bindings: number; readonly runs: number };
    }
  | { readonly status: "refused"; readonly reason: string; readonly preparation: "none" }
  | {
      readonly status: "outcome_unknown";
      readonly reason: "interrupted";
      readonly attempt?: { readonly key: string; readonly command: string };
    };

const command = defineCommand({
  id: "connector.owner.removeAllBindings",
  input: z.strictObject({ id: idSchema, gids: z.array(z.string().min(1).max(128)).max(100) }),
  run(ctx, input) {
    if (!ctx.lease.isHolder()) return refuse("owner_authority_lost");
    const rows = ctx.read<{ gid: string }>(
      "SELECT gid FROM connector_bindings WHERE connector_id = ? ORDER BY gid LIMIT 101",
      input.id,
    );
    if (rows.length > 100) return refuse("too_many_bindings");
    if (JSON.stringify(rows.map((row) => row.gid)) !== JSON.stringify(input.gids))
      return refuse("binding_set_changed");
    for (const row of rows) ctx.emit("connectorBinding.removed", row.gid, {});
    return ok({ bindings: rows.length });
  },
});

function markerPath(catalog: ConnectorCatalog, id: string): string {
  return join(catalog.root, `.removing-${id}.json`);
}
function sync(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function marker(catalog: ConnectorCatalog, id: string): Marker | null {
  catalog.assertCurrentRoot();
  const path = markerPath(catalog, id);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16384 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("connector_removal_marker_invalid");
    const bytes = Buffer.alloc(16385);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size) throw new Error("connector_removal_marker_invalid");
    const row = markerSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    if (row.id !== id) throw new Error("connector_removal_marker_invalid");
    return row;
  } finally {
    closeSync(fd);
  }
}
function mark(catalog: ConnectorCatalog, row: Marker): void {
  catalog.assertCurrentRoot();
  const path = markerPath(catalog, row.id);
  const bytes = JSON.stringify(markerSchema.parse(row));
  if (Buffer.byteLength(bytes) > 16384) throw new Error("connector_removal_marker_invalid");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  sync(catalog.root);
  // The fence makes the connector unapprovable: the live Settings list shows it.
  catalog.changed();
}
function updateMarker(catalog: ConnectorCatalog, row: Marker): void {
  catalog.assertCurrentRoot();
  const bytes = JSON.stringify(markerSchema.parse(row));
  if (Buffer.byteLength(bytes) > 16384) throw new Error("connector_removal_marker_invalid");
  const temporary = join(catalog.root, `.removing-write-${randomBytes(16).toString("hex")}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, markerPath(catalog, row.id));
    sync(catalog.root);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function unmark(catalog: ConnectorCatalog, id: string): void {
  catalog.assertCurrentRoot();
  rmSync(markerPath(catalog, id));
  sync(catalog.root);
  catalog.changed();
}
const bindings = (vault: OpenVault, id: string): readonly { gid: string }[] =>
  vault.store.read<{ gid: string }>(
    "SELECT gid FROM connector_bindings WHERE connector_id = ? ORDER BY gid LIMIT 101",
    id,
  );
const refs = (stores: HostStores, id: string): boolean =>
  [...stores.vaults.values()].some((vault) => bindings(vault, id).length > 0) ||
  stores.device.store.read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM connector_runs WHERE connector_id = ?",
    id,
  )[0]?.n !== 0;

/** Owner Settings deletion. Secrets first, then one durable binding command per vault, then local history/code. */
export async function removeConnectorOwner(input: {
  readonly stores: HostStores;
  readonly catalog: ConnectorCatalog;
  readonly id: string;
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly now: () => number;
  isCurrent(): boolean;
  /** Synthetic tests replace only the Keychain boundary. */
  readonly cleanup?: typeof deletionOnlyConnectorSecrets;
  readonly inventory?: typeof readExistingNativeInventory;
  readonly execute?: (
    vault: OpenVault,
    key: string,
    current: () => boolean,
  ) => Promise<DurableCommandResult<unknown>>;
}): Promise<Result> {
  const parsed = idSchema.safeParse(input.id);
  if (!parsed.success)
    return { status: "refused", reason: "owner_authority_unavailable", preparation: "none" };
  let existing: Marker | null;
  try {
    existing = marker(input.catalog, input.id);
  } catch {
    return { status: "outcome_unknown", reason: "interrupted" };
  }
  if (!input.isCurrent() || !input.lock.held)
    return existing
      ? { status: "outcome_unknown", reason: "interrupted" }
      : { status: "refused", reason: "owner_authority_unavailable", preparation: "none" };
  const readInventory = input.inventory ?? readExistingNativeInventory;
  let inventory: ReturnType<typeof readExistingNativeInventory>;
  try {
    inventory = readInventory(input.dataDir);
  } catch {
    return existing
      ? { status: "outcome_unknown", reason: "interrupted" }
      : { status: "refused", reason: "vault_authority_unavailable", preparation: "none" };
  }
  let expectedVaults: readonly OpenVault[] = [];
  const current = () =>
    input.isCurrent() &&
    input.lock.held &&
    readInventory(input.dataDir).fingerprint === inventory.fingerprint &&
    expectedVaults.every(
      (vault) => input.stores.vaults.get(vault.id) === vault && vault.native?.isCurrent(),
    );
  const fenced = () => current() && input.catalog.removalActive(input.id);
  let changed = false;
  try {
    const vaults = [...input.stores.vaults.values()].sort((a, b) => a.id.localeCompare(b.id));
    expectedVaults = vaults;
    if (
      vaults.length === 0 ||
      inventory.entries.length !== vaults.length ||
      inventory.entries.some(
        (entry) => entry.state !== "ready" || !vaults.some((vault) => vault.id === entry.vaultId),
      ) ||
      vaults.some((vault) => vault.mode !== "native" || !vault.native?.isCurrent())
    )
      return existing
        ? { status: "outcome_unknown", reason: "interrupted" }
        : { status: "refused", reason: "vault_authority_unavailable", preparation: "none" };
    let journal = existing;
    let loaded: ReturnType<ConnectorCatalog["installed"]>;
    try {
      loaded = input.catalog.installed(input.id);
    } catch (error) {
      const codeMissing =
        lstatSync(join(input.catalog.root, input.id), { throwIfNoEntry: false }) === undefined;
      if (journal && codeMissing && !refs(input.stores, input.id)) {
        unmark(input.catalog, input.id);
        return {
          status: "completed",
          value: {
            bindings: journal.snapshot.reduce((n, item) => n + item.gids.length, 0),
            runs: 0,
          },
        };
      }
      throw error;
    }
    if (!journal) {
      const snapshot = vaults.map((vault) => ({
        vault: vault.id,
        gids: bindings(vault, input.id).map((row) => row.gid),
      }));
      if (snapshot.reduce((count, item) => count + item.gids.length, 0) > 100)
        return { status: "refused", reason: "too_many_bindings", preparation: "none" };
      journal = { id: input.id, digest: loaded.contentSha256, snapshot, pending: null };
      mark(input.catalog, journal);
      changed = true;
    }
    if (
      journal.digest !== loaded.contentSha256 ||
      JSON.stringify(journal.snapshot.map((item) => item.vault)) !==
        JSON.stringify(vaults.map((vault) => vault.id))
    )
      return { status: "outcome_unknown", reason: "interrupted" };
    if (journal.pending) {
      const pendingVault = input.stores.vaults.get(journal.pending.vault);
      if (!pendingVault?.native?.isCurrent())
        return { status: "outcome_unknown", reason: "interrupted" };
      const status = pendingVault.native.attempts.status(
        pendingVault.id,
        journal.pending.key,
        command.id,
      );
      if (status.phase === "may_append")
        return {
          status: "outcome_unknown",
          reason: "interrupted",
          attempt: { key: journal.pending.key, command: command.id },
        };
      if (status.phase === "terminal") {
        journal = { ...journal, pending: null };
        updateMarker(input.catalog, journal);
      }
      if (status.phase === "completed") {
        const expected =
          journal.snapshot.find((item) => item.vault === pendingVault.id)?.gids ?? [];
        if (expected.some((gid) => bindings(pendingVault, input.id).some((row) => row.gid === gid)))
          return { status: "outcome_unknown", reason: "interrupted" };
        journal = { ...journal, pending: null };
        updateMarker(input.catalog, journal);
      }
    }
    let removed = 0;
    for (const vault of vaults) {
      const expected = journal.snapshot.find((item) => item.vault === vault.id)?.gids ?? [];
      const rows = bindings(vault, input.id);
      if (journal.pending && journal.pending.vault !== vault.id) {
        if (rows.length > 0) return { status: "outcome_unknown", reason: "interrupted" };
        continue;
      }
      if (rows.length === 0 && !journal.pending) continue;
      if (JSON.stringify(rows.map((row) => row.gid)) !== JSON.stringify(expected))
        return { status: "outcome_unknown", reason: "interrupted" };
      if (loaded.manifest.kind === "fetch") {
        for (const row of rows) {
          const cleanup = (input.cleanup ?? deletionOnlyConnectorSecrets)({
            catalog: input.catalog,
            binding: {
              id: row.gid,
              profileId: vault.id,
              accountId: "",
              connectorId: input.id,
              module: loaded.manifest.module,
              enabled: false,
              params: {},
              cursor: null,
            },
            authority: {
              dataDir: input.dataDir,
              lock: input.lock,
              isOwnerAction: fenced,
              isCurrent: (identity) =>
                fenced() &&
                identity.profileId === vault.id &&
                identity.bindingId === row.gid &&
                identity.connectorId === input.id &&
                bindings(vault, input.id).some((candidate) => candidate.gid === row.gid),
            },
          });
          for (const secretId of cleanup.secretIds) {
            await cleanup.clear(secretId);
            changed = true;
          }
        }
      }
      if (
        JSON.stringify(bindings(vault, input.id).map((row) => row.gid)) !== JSON.stringify(expected)
      )
        return { status: "outcome_unknown", reason: "interrupted" };
      if (!journal.pending) {
        journal = {
          ...journal,
          pending: {
            vault: vault.id,
            key: mintUlid(input.now(), (n) => new Uint8Array(randomBytes(n))),
          },
        };
        updateMarker(input.catalog, journal);
      }
      changed = true;
      const key = journal.pending?.key;
      if (!key) return { status: "outcome_unknown", reason: "interrupted" };
      const outcome = input.execute
        ? await input.execute(vault, key, fenced)
        : await runHostVaultCommand(vault, command, { id: input.id, gids: expected }, key, fenced);
      if (outcome.kind === "outcome_unknown")
        return {
          status: "outcome_unknown",
          reason: "interrupted",
          attempt: { key: outcome.key, command: command.id },
        };
      if (outcome.kind !== "completed") return { status: "outcome_unknown", reason: "interrupted" };
      removed += expected.length;
      journal = { ...journal, pending: null };
      updateMarker(input.catalog, journal);
    }
    if (
      !current() ||
      [...input.stores.vaults.values()].some((vault) => bindings(vault, input.id).length > 0)
    )
      return { status: "outcome_unknown", reason: "interrupted" };
    const runs = await input.stores.device.queue.run(() =>
      input.stores.device.store.removeConnectorRuns(input.id, {
        ownerAction: true,
        isCurrent: current,
      }),
    );
    changed = true;
    input.catalog.removeUnbound(
      input.id,
      { ownerAction: true, isCurrent: current },
      () => !refs(input.stores, input.id),
      { allowRemovalFence: true },
    );
    unmark(input.catalog, input.id);
    return { status: "completed", value: { bindings: removed, runs } };
  } catch {
    return changed || input.catalog.removalActive(input.id)
      ? { status: "outcome_unknown", reason: "interrupted" }
      : { status: "refused", reason: "connector_unavailable", preparation: "none" };
  }
}
