import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { crypto } from "@cashu/sync";
import {
  type FileEntry,
  ID,
  type Locator,
  MAX_LOCATOR_BYTES as MAX_LOCATOR,
  MAX_MANIFEST_BYTES as MAX_MANIFEST,
  MAX_TOTAL_BYTES,
  type Manifest,
} from "./format.js";
import {
  assertPins,
  captureFile,
  createPrivateDir,
  estimatedManifestBytes,
  existingDir,
  listPrivateFiles,
  pinDirectory,
  privateDir,
  readPrivate,
  scrubIncompleteNativeCheckpoints,
  sealChunk,
  syncDirectory,
  unavailable,
  writePrivate,
} from "./fs.js";
import { checkDatabase, locatorAt, manifestAt, verifyFilesAsync } from "./inspection.js";
import { parseJson } from "./json.js";

export interface NativeCheckpointSource {
  readonly root: string;
  readonly vault: string;
  readonly device: string;
  readonly sodium: crypto.Sodium;
  readonly ring: crypto.Keyring;
  readonly identity: crypto.DeviceIdentity;
  readonly baseRecoveryWrap: Uint8Array;
  readonly certificates: readonly Uint8Array[];
  /** Stable applied frontier, captured and checked while the vault queue is held. */
  frontier(): string;
  isCurrent(): boolean;
  /** Online SQLite backup from the already open, exclusively locked connection. */
  backupDatabase(name: "private.db" | "view.db", destination: string): Promise<void>;
}

export interface NativeCheckpointReceipt {
  readonly path: string;
  readonly vault: string;
  readonly frontier: string;
  readonly files: number;
}

function assertRootArtifacts(source: NativeCheckpointSource): void {
  const cert = parseJson(readPrivate(join(source.root, "certificates.v1.json"), 32 * 1024));
  if (typeof cert !== "object" || cert === null || Array.isArray(cert)) unavailable();
  const certRecord = cert as Record<string, unknown>;
  const expected = source.certificates.map((bytes) => Buffer.from(bytes).toString("base64url"));
  if (
    certRecord.format !== 1 ||
    certRecord.vaultId !== source.vault ||
    certRecord.deviceId !== source.device ||
    !Array.isArray(certRecord.certificates) ||
    certRecord.certificates.length !== expected.length ||
    certRecord.certificates.some((value, index) => value !== expected[index])
  )
    unavailable();
  const wrap = parseJson(readPrivate(join(source.root, "recovery-wrap.v1"), 32 * 1024));
  if (typeof wrap !== "object" || wrap === null || Array.isArray(wrap)) unavailable();
  const wrapRecord = wrap as Record<string, unknown>;
  if (
    wrapRecord.format !== 1 ||
    wrapRecord.vaultId !== source.vault ||
    wrapRecord.wrap !== Buffer.from(source.baseRecoveryWrap).toString("base64url")
  )
    unavailable();
}
export async function createNativeCheckpoint(
  source: NativeCheckpointSource,
): Promise<NativeCheckpointReceipt> {
  if (
    !ID.test(source.vault) ||
    !ID.test(source.device) ||
    source.root !== resolve(source.root) ||
    basename(source.root) !== source.vault ||
    basename(dirname(source.root)) !== "vaults" ||
    source.ring.vaultId !== source.vault ||
    source.identity.deviceId !== source.device ||
    !source.isCurrent()
  )
    unavailable();
  privateDir(source.root);
  assertRootArtifacts(source);
  const recipient = crypto.recoveryRecipient(source.ring);
  const certified = crypto
    .verifyCertificates(
      source.sodium,
      source.vault,
      source.ring.recovery.signPublicKey,
      source.certificates,
      new Set(),
    )
    .devices.get(source.device);
  if (
    !certified ||
    !Buffer.from(certified.signPublicKey).equals(Buffer.from(source.identity.signPublicKey)) ||
    !crypto.verifyWrapSignature(
      source.baseRecoveryWrap,
      source.vault,
      recipient,
      crypto.RECOVERY_SIGNER_ID,
      source.ring.recovery.signPublicKey,
    )
  )
    unavailable();
  const frontier = source.frontier();
  const key = source.ring.active.kid;
  const parent = join(source.root, "checkpoints");
  scrubIncompleteNativeCheckpoints(source.root);
  if (!existingDir(parent)) createPrivateDir(parent);
  const id = randomUUID();
  const stage = join(parent, `.${id}.partial`);
  const final = join(parent, id);
  createPrivateDir(stage);
  try {
    createPrivateDir(join(stage, "chunks"));
    createPrivateDir(join(stage, "scratch"));
    const pins = [source.root, parent, stage, join(stage, "chunks")].map(pinDirectory);
    const scratchPin = pinDirectory(join(stage, "scratch"));
    let scratchActive = true;
    const budget = {
      files: 4,
      bytes: 0,
      manifestBytes: 1024,
      directories: 0,
      pins: [] as ReturnType<typeof pinDirectory>[],
    };
    const sourcePins = new Map<string, ReturnType<typeof pinDirectory>>();
    const stillCurrent = (sourcePath?: string) => {
      assertPins(pins);
      if (scratchActive) assertPins([scratchPin]);
      if (sourcePath) {
        let ancestor = dirname(sourcePath);
        while (ancestor.startsWith(source.root) && ancestor !== source.root) {
          const pin = sourcePins.get(ancestor);
          if (pin) assertPins([pin]);
          ancestor = dirname(ancestor);
        }
      }
      return source.isCurrent() && source.frontier() === frontier && source.ring.active.kid === key;
    };
    for (const name of ["certificates.v1.json", "recovery-wrap.v1"]) {
      const size = lstatSync(join(source.root, name)).size;
      budget.bytes += size;
      budget.manifestBytes += estimatedManifestBytes(name, size);
    }
    const extraFiles: string[] = [];
    for (const dir of ["log", "blobs", "strategy"]) {
      if (!existingDir(join(source.root, dir))) {
        if (dir === "log") unavailable();
        continue;
      }
      extraFiles.push(...listPrivateFiles(source.root, dir, budget));
    }
    for (const pin of budget.pins) sourcePins.set(pin.path, pin);
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_TOTAL_BYTES) unavailable();
    const files: FileEntry[] = [];
    for (const name of ["private.db", "view.db"] as const) {
      const scratch = join(stage, "scratch", name);
      assertPins([...pins, scratchPin]);
      if (!stillCurrent()) unavailable();
      await source.backupDatabase(name, scratch);
      assertPins([...pins, scratchPin]);
      if (!stillCurrent()) unavailable();
      const backupSize = lstatSync(scratch).size;
      budget.bytes += backupSize;
      budget.manifestBytes += estimatedManifestBytes(name, backupSize);
      if (
        !Number.isSafeInteger(budget.bytes) ||
        budget.bytes > MAX_TOTAL_BYTES ||
        budget.manifestBytes > MAX_MANIFEST
      )
        unavailable();
      checkDatabase(scratch, name).close();
      files.push(
        await captureFile(
          scratch,
          stage,
          name,
          source.sodium,
          source.ring,
          source.vault,
          stillCurrent,
        ),
      );
      rmSync(scratch);
    }
    rmSync(join(stage, "scratch"), { recursive: true });
    scratchActive = false;
    assertRootArtifacts(source);
    for (const name of ["certificates.v1.json", "recovery-wrap.v1"])
      files.push(
        await captureFile(
          join(source.root, name),
          stage,
          name,
          source.sodium,
          source.ring,
          source.vault,
          stillCurrent,
        ),
      );
    for (const name of extraFiles)
      files.push(
        await captureFile(
          join(source.root, name),
          stage,
          name,
          source.sodium,
          source.ring,
          source.vault,
          stillCurrent,
        ),
      );
    if (!stillCurrent()) unavailable();
    assertPins(budget.pins);
    assertRootArtifacts(source);
    const manifest: Manifest = {
      format: 1,
      vault: source.vault,
      device: source.device,
      frontier,
      key,
      files,
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    let manifestRef: Locator["manifest"];
    try {
      if (bytes.length > MAX_MANIFEST) unavailable();
      manifestRef = sealChunk(stage, source.sodium, source.ring, source.vault, bytes, "manifest");
    } finally {
      bytes.fill(0);
    }
    const currentWraps = source.ring.entries().map((entry) => {
      const wrap = crypto.wrapKeys(source.sodium, source.ring, source.identity, recipient, [
        entry.kid,
      ]);
      if (
        !crypto.verifyWrapSignature(
          wrap,
          source.vault,
          recipient,
          source.device,
          source.identity.signPublicKey,
        )
      )
        unavailable();
      return Buffer.from(wrap).toString("base64url");
    });
    const locator: Locator = {
      format: 1,
      vault: source.vault,
      device: source.device,
      manifest: manifestRef,
      baseWrap: Buffer.from(source.baseRecoveryWrap).toString("base64url"),
      currentWraps,
      certificates: source.certificates.map((c) => Buffer.from(c).toString("base64url")),
    };
    const locatorBytes = Buffer.from(JSON.stringify(locator));
    try {
      if (locatorBytes.length > MAX_LOCATOR) unavailable();
      writePrivate(join(stage, "locator.json"), locatorBytes);
    } finally {
      locatorBytes.fill(0);
    }
    syncDirectory(join(stage, "chunks"));
    syncDirectory(stage);
    const checked = locatorAt(stage);
    await verifyFilesAsync(
      stage,
      manifestAt(stage, checked, source.sodium, source.ring),
      source.sodium,
      source.ring,
      stillCurrent,
    );
    if (!stillCurrent()) unavailable();
    assertPins(budget.pins);
    renameSync(stage, final);
    syncDirectory(parent);
    return { path: final, vault: source.vault, frontier, files: files.length };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
