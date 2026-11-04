/** Device-local job switch for a native-only data dir. The Python side reads this exact record. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";
import { z } from "zod";
import type { OpenVault } from "../stores.js";
import type { WorkerJob } from "./contracts.js";

const id = z.string().regex(/^[0-9a-f]{32}$/u);
const schema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  jobs: z.strictObject({
    "investments.daily": z.strictObject({
      owner: z.literal("native"),
      vaults: z
        .array(id)
        .min(1)
        .max(64)
        .refine((vaults) => new Set(vaults).size === vaults.length),
    }),
    "connectors.fetch": z.strictObject({
      owner: z.literal("native"),
      vaults: z
        .array(id)
        .min(1)
        .max(64)
        .refine((vaults) => new Set(vaults).size === vaults.length),
    }),
  }),
});
type Record = z.infer<typeof schema>;
const MAX_BYTES = 16 * 1024;

function privateFile(path: string): Buffer | null {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > MAX_BYTES ||
    (before.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && before.uid !== process.getuid())
  )
    throw new Error("worker_ownership_unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_BYTES ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && opened.uid !== process.getuid())
    )
      throw new Error("worker_ownership_unavailable");
    const bytes = readFileSync(fd);
    const after = lstatSync(path);
    if (bytes.length !== opened.size || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error("worker_ownership_unavailable");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readRecord(path: string): Record | null {
  const bytes = privateFile(path);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return schema.parse(value);
  } catch {
    throw new Error("worker_ownership_unavailable");
  }
}

function writeRecord(path: string, value: Record, expected: Record | null): void {
  const root = dirname(path);
  const bytes = Buffer.from(JSON.stringify(schema.parse(value)));
  if (bytes.length > MAX_BYTES) throw new Error("worker_ownership_unavailable");
  const temp = join(root, `.ownership-${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    const previous = readRecord(path);
    if (JSON.stringify(previous) !== JSON.stringify(expected))
      throw new Error("worker_ownership_unavailable");
    renameSync(temp, path);
    const dir = openSync(root, constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface AdmittedWorkerOwnership {
  isExclusive(job: WorkerJob, vault: OpenVault): boolean;
}

/** Called only after checked native-only or completed-migration admission under HostLock. */
export function admittedWorkerOwnership(input: {
  readonly dataDir: string;
  /** Only vaults whose current file/write authority has already been checked. */
  readonly vaults: readonly OpenVault[];
  /** Mandatory host capability. Before T54 it rejects every legacy source root; afterward it may
   * accept only authenticated completed admission while retaining the rollback database. */
  assertAdmission(): void;
}): AdmittedWorkerOwnership {
  input.assertAdmission();
  const vaults = input.vaults;
  if (vaults.some((v) => v.mode !== "native" || !v.native.canRunSideEffects()))
    throw new Error("worker_ownership_unavailable");
  const root = join(input.dataDir, "worker");
  ensurePrivateDir(root);
  const pin = lstatSync(root);
  const path = join(root, "ownership.json");
  const expected = [...new Set(vaults.map((v) => v.id))].sort();
  if (expected.length !== vaults.length || expected.some((v) => !id.safeParse(v).success))
    throw new Error("worker_ownership_unavailable");
  const old = readRecord(path);
  const combined = [
    ...new Set([...(old?.jobs["investments.daily"].vaults ?? []), ...expected]),
  ].sort();
  const connectorVaults = [
    ...new Set([...(old?.jobs["connectors.fetch"].vaults ?? []), ...expected]),
  ].sort();
  if (combined.length > 64 || old?.generation === Number.MAX_SAFE_INTEGER)
    throw new Error("worker_ownership_unavailable");
  if (
    combined.length !== 0 &&
    (old === null ||
      combined.length !== old.jobs["investments.daily"].vaults.length ||
      connectorVaults.length !== old.jobs["connectors.fetch"].vaults.length)
  )
    writeRecord(
      path,
      {
        version: 1,
        generation: (old?.generation ?? 0) + 1,
        jobs: {
          "investments.daily": { owner: "native", vaults: combined },
          "connectors.fetch": { owner: "native", vaults: connectorVaults },
        },
      },
      old,
    );
  const generation = readRecord(path)?.generation ?? 0;
  const current = () => {
    try {
      input.assertAdmission();
      const now = lstatSync(root);
      if (
        !now.isDirectory() ||
        now.dev !== pin.dev ||
        now.ino !== pin.ino ||
        (now.mode & 0o077) !== 0
      )
        return false;
      const record = readRecord(path);
      return (
        record !== null &&
        record.generation >= generation &&
        record.jobs["investments.daily"].owner === "native" &&
        expected.every((vault) => record.jobs["investments.daily"].vaults.includes(vault)) &&
        record.jobs["connectors.fetch"].owner === "native" &&
        expected.every((vault) => record.jobs["connectors.fetch"].vaults.includes(vault))
      );
    } catch {
      return false;
    }
  };
  if (expected.length !== 0 && !current()) throw new Error("worker_ownership_unavailable");
  return {
    isExclusive(job, vault) {
      return (
        (job === "investments.daily" || job === "connectors.fetch") &&
        vault.mode === "native" &&
        expected.includes(vault.id) &&
        vault.native.canRunSideEffects() &&
        current()
      );
    },
  };
}
