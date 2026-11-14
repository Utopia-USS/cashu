import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { backupNodeSqlite, openNodeSqlite } from "@cashu/node-host/sqlite";
import { crypto } from "@cashu/sync";
import { expect, it } from "vitest";
import { createNativeCheckpoint, scrubIncompleteNativeCheckpoints } from "./nativeCheckpoint.js";
import {
  inspectNativeCheckpoint,
  withIsolatedNativeCheckpoint,
} from "./testing/nativeCheckpointInspection.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

/** Inspects the archive in a fresh Node process (no state shared with this one); prints the result. */
const FRESH_PROCESS_INSPECTION = `
const { inspectNativeCheckpoint } = await import(${JSON.stringify(new URL("./testing/nativeCheckpointInspection.ts", import.meta.url).href)});
const { crypto } = await import("@cashu/sync");
const path = process.env.CASHU_SYNTHETIC_CHECKPOINT_PATH;
const words = process.env.CASHU_SYNTHETIC_CHECKPOINT_WORDS;
if (!path || !words) throw new Error("missing synthetic inspection input");
const result = inspectNativeCheckpoint(path, words, await crypto.loadNodeSodium());
process.stdout.write(JSON.stringify({ files: result.files, frontier: result.frontier }));
`;

it("seals a live native archive and independently opens both SQLite backups", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const root = join(fixture.dataDir, "vaults", fixture.vaultId);
  const { keyStore, sodium, inventory } = fixture.vaultSource.provider;
  const entry = inventory[0];
  if (!entry) throw new Error("missing synthetic vault");
  const ring = await crypto.loadKeyring(keyStore, sodium, fixture.vaultId);
  const identity = await crypto.loadDeviceIdentity(keyStore, entry.deviceId);
  if (!ring || !identity) throw new Error("missing synthetic keys");
  const recovery = crypto.recoveryIdentity(sodium, fixture.recoveryWords);
  const baseWrap = crypto.wrapKeys(sodium, ring, recovery, crypto.recoveryRecipient(ring));
  crypto.rotateKeyring(sodium, ring, { epoch: 1 });
  crypto.rotateKeyring(sodium, ring, { epoch: 2 });
  expect(ring.active.epoch).toBe(2);
  const certificates = await fixture.vaultSource.provider.bootstrapCertificates();
  chmodSync(fixture.dataDir, 0o700);
  chmodSync(join(fixture.dataDir, "vaults"), 0o700);
  chmodSync(root, 0o700);
  chmodSync(join(root, "log"), 0o700);
  writeFileSync(
    join(root, "certificates.v1.json"),
    JSON.stringify({
      format: 1,
      vaultId: fixture.vaultId,
      deviceId: entry.deviceId,
      certificates: certificates.map((c) => Buffer.from(c).toString("base64url")),
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "recovery-wrap.v1"),
    JSON.stringify({
      format: 1,
      vaultId: fixture.vaultId,
      wrap: Buffer.from(baseWrap).toString("base64url"),
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(root, "strategy", "strategy.yaml"), "synthetic: true\n", { mode: 0o600 });
  mkdirSync(hostRunPaths(fixture.dataDir).runDir, { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(fixture.dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  const privateDb = openNodeSqlite(join(root, "private.db"), { exclusive: lock });
  const viewDb = openNodeSqlite(join(root, "view.db"), { exclusive: lock });
  try {
    const receipt = await createNativeCheckpoint({
      root,
      vault: fixture.vaultId,
      device: entry.deviceId,
      sodium,
      ring,
      identity,
      baseRecoveryWrap: baseWrap,
      certificates,
      frontier: () => "synthetic-frontier",
      isCurrent: () => lock.held,
      backupDatabase: (name, destination) =>
        backupNodeSqlite(name === "private.db" ? privateDb : viewDb, destination),
    });
    expect(receipt.files).toBeGreaterThanOrEqual(4);
    expect(readdirSync(receipt.path).sort()).toEqual(["chunks", "locator.json"]);
    const abandoned = join(root, "checkpoints", ".00000000-0000-0000-0000-000000000000.partial");
    mkdirSync(abandoned, { mode: 0o700 });
    writeFileSync(join(abandoned, "scratch.db"), "synthetic", { mode: 0o600 });
    scrubIncompleteNativeCheckpoints(root);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(receipt.path)).toBe(true);
    expect(inspectNativeCheckpoint(receipt.path, fixture.recoveryWords, sodium).files).toBe(
      receipt.files,
    );
    let isolatedRoot = "";
    await withIsolatedNativeCheckpoint(
      receipt.path,
      fixture.recoveryWords,
      sodium,
      async (snapshot) => {
        isolatedRoot = snapshot.root;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(existsSync(snapshot.root)).toBe(true);
        expect(snapshot.viewDb.prepare("SELECT COUNT(*) AS n FROM profiles").get()).toEqual({
          n: 1,
        });
        expect(readFileSync(join(snapshot.root, "strategy", "strategy.yaml"), "utf8")).toBe(
          "synthetic: true\n",
        );
      },
    );
    expect(existsSync(isolatedRoot)).toBe(false);
    let rejectedRoot = "";
    await expect(
      withIsolatedNativeCheckpoint(receipt.path, fixture.recoveryWords, sodium, (snapshot) => {
        rejectedRoot = snapshot.root;
        snapshot.viewDb.close();
        throw new Error("synthetic inspection stopped");
      }),
    ).rejects.toThrow("synthetic inspection stopped");
    expect(existsSync(rejectedRoot)).toBe(false);
    expect(() => inspectNativeCheckpoint(receipt.path, "wrong words", sodium)).toThrow();
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const run = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        join(repo, "tools", "node-ts", "resolveTs.ts"),
        "--input-type=module",
        "-e",
        FRESH_PROCESS_INSPECTION,
      ],
      {
        cwd: join(repo, "apps", "host"),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture.home,
          TMPDIR: realpathSync(tmpdir()),
          CASHU_SYNTHETIC_CHECKPOINT_PATH: receipt.path,
          CASHU_SYNTHETIC_CHECKPOINT_WORDS: fixture.recoveryWords,
        },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const inspected = JSON.parse(run.stdout) as { files: number; frontier: string };
    expect(inspected.files).toBeGreaterThanOrEqual(4);
    expect(inspected.frontier).toBe("synthetic-frontier");
    const chunk = readdirSync(join(receipt.path, "chunks"))[0];
    if (!chunk) throw new Error("missing synthetic chunk");
    const path = join(receipt.path, "chunks", chunk);
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(path, bytes);
    expect(() => inspectNativeCheckpoint(receipt.path, fixture.recoveryWords, sodium)).toThrow();
  } finally {
    privateDb.close();
    viewDb.close();
    lock.release();
    recovery.wipe();
    identity.wipe();
    ring.wipe();
    fixture.cleanup();
  }
});

it("refuses a symlinked strategy file before publication", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  const root = join(fixture.dataDir, "vaults", fixture.vaultId);
  try {
    chmodSync(root, 0o700);
    chmodSync(join(root, "log"), 0o700);
    symlinkSync(join(root, "view.db"), join(root, "strategy", "strategy.yaml"));
    const sodium = fixture.vaultSource.provider.sodium;
    const ring = await crypto.loadKeyring(
      fixture.vaultSource.provider.keyStore,
      sodium,
      fixture.vaultId,
    );
    const identity = await crypto.loadDeviceIdentity(
      fixture.vaultSource.provider.keyStore,
      fixture.vaultSource.provider.inventory[0]?.deviceId ?? "",
    );
    if (!ring || !identity) throw new Error("missing synthetic keys");
    const recovery = crypto.recoveryIdentity(sodium, fixture.recoveryWords);
    const baseRecoveryWrap = crypto.wrapKeys(
      sodium,
      ring,
      recovery,
      crypto.recoveryRecipient(ring),
    );
    const certificates = await fixture.vaultSource.provider.bootstrapCertificates();
    writeFileSync(
      join(root, "certificates.v1.json"),
      JSON.stringify({
        format: 1,
        vaultId: fixture.vaultId,
        deviceId: identity.deviceId,
        certificates: certificates.map((c) => Buffer.from(c).toString("base64url")),
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "recovery-wrap.v1"),
      JSON.stringify({
        format: 1,
        vaultId: fixture.vaultId,
        wrap: Buffer.from(baseRecoveryWrap).toString("base64url"),
      }),
      { mode: 0o600 },
    );
    try {
      await expect(
        createNativeCheckpoint({
          root,
          vault: fixture.vaultId,
          device: identity.deviceId,
          sodium,
          ring,
          identity,
          baseRecoveryWrap,
          certificates,
          frontier: () => "synthetic-frontier",
          isCurrent: () => true,
          backupDatabase: async (name, destination) => {
            copyFileSync(join(root, name), destination);
            chmodSync(destination, 0o600);
          },
        }),
      ).rejects.toThrow("native_checkpoint_unavailable");
      expect(readdirSync(join(root, "checkpoints"))).toEqual([]);
    } finally {
      recovery.wipe();
      ring.wipe();
      identity.wipe();
    }
  } finally {
    fixture.cleanup();
  }
});
