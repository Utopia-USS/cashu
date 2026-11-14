import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ConnectorCatalog } from "../connectors/catalog.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const secretId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const vaultId = z.string().regex(/^[a-f0-9]{32}$/);
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((key) => [...key].every((char) => char.charCodeAt(0) >= 32));
const resultSchema = z.strictObject({
  id,
  status: z.literal("pending"),
  replaced: z.boolean(),
  contentSha256: digest,
  module: z.enum(["budget", "investments"]),
  kind: z.enum(["file", "fetch"]),
  hosts: z.array(z.string().max(255)).max(20),
  secretIds: z.array(secretId).max(20),
});
export type ConnectorProposalResult = z.infer<typeof resultSchema>;
const base = {
  key: keySchema,
  vault: vaultId,
  requestHash: digest,
  id,
  contentSha256: digest,
  replaced: z.boolean(),
};
const receiptSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...base, phase: z.literal("intent") }),
  z.strictObject({ ...base, phase: z.literal("completed"), result: resultSchema }),
]);
export type ConnectorProposalReceipt = z.infer<typeof receiptSchema>;
type Intent = Extract<ConnectorProposalReceipt, { phase: "intent" }>;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const connectorRequestHash = (request: {
  readonly path?: string;
  readonly catalogId?: string;
}): string => hash(JSON.stringify([request.path ?? null, request.catalogId ?? null]));

function privateDir(path: string): { dev: number; ino: number } {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync.native(path) !== resolve(path) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("connector_receipt_directory_unavailable");
  return { dev: stat.dev, ino: stat.ino };
}
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

/** Durable value-free MCP install receipts, separate from financial command attempts. */
export class ConnectorProposalReceipts {
  readonly root: string;
  private readonly dataPin: { dev: number; ino: number };
  private readonly rootPin: { dev: number; ino: number };
  private readonly vaultPins = new Map<string, { dev: number; ino: number }>();
  constructor(dataDir: string) {
    this.dataPin = privateDir(dataDir);
    this.root = join(dataDir, "mcp-connector-receipts");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.rootPin = privateDir(this.root);
  }
  private directory(vault: string, create: boolean): string | null {
    vaultId.parse(vault);
    if (
      !same(privateDir(resolve(this.root, "..")), this.dataPin) ||
      !same(privateDir(this.root), this.rootPin)
    )
      throw new Error("connector_receipt_directory_changed");
    const dir = join(this.root, vault);
    if (!existsSync(dir) && create) {
      mkdirSync(dir, { mode: 0o700 });
      this.syncDir(this.root);
    }
    if (!existsSync(dir)) return null;
    const pin = privateDir(dir);
    const previous = this.vaultPins.get(vault);
    if (previous && !same(pin, previous)) throw new Error("connector_receipt_directory_changed");
    this.vaultPins.set(vault, pin);
    return dir;
  }
  private file(key: string, vault: string, create = false): string | null {
    keySchema.parse(key);
    const dir = this.directory(vault, create);
    return dir ? join(dir, `${hash(key)}.json`) : null;
  }
  lookup(key: string, vault: string): ConnectorProposalReceipt | null {
    const file = this.file(key, vault);
    if (!file) return null;
    let bytes: Buffer;
    try {
      const fd = openSync(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 8192 ||
          (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())
        )
          throw new Error("connector_receipt_invalid");
        const buffer = Buffer.alloc(8193);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        if (length > 8192 || length !== stat.size) throw new Error("connector_receipt_invalid");
        bytes = buffer.subarray(0, length);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const row = receiptSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (row.key !== key || row.vault !== vault) throw new Error("request_key_conflict");
    return row;
  }
  begin(row: Omit<Intent, "phase">): Intent {
    if (this.lookup(row.key, row.vault)) throw new Error("request_key_conflict");
    const receipt = receiptSchema.parse({ ...row, phase: "intent" }) as Intent;
    const file = this.file(row.key, row.vault, true);
    if (!file) throw new Error("connector_receipt_directory_unavailable");
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(receipt));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncDir(join(this.root, row.vault));
    return receipt;
  }
  complete(row: Intent, result: ConnectorProposalResult): ConnectorProposalReceipt {
    if (
      result.id !== row.id ||
      result.contentSha256 !== row.contentSha256 ||
      result.replaced !== row.replaced
    )
      throw new Error("connector_receipt_result_mismatch");
    const prior = this.lookup(row.key, row.vault);
    if (
      !prior ||
      prior.requestHash !== row.requestHash ||
      prior.contentSha256 !== row.contentSha256 ||
      prior.id !== row.id
    )
      throw new Error("request_key_conflict");
    if (prior.phase === "completed") return prior;
    const completed = receiptSchema.parse({ ...row, phase: "completed", result });
    const dir = this.directory(row.vault, false);
    const file = this.file(row.key, row.vault);
    if (!dir || !file) throw new Error("connector_receipt_directory_unavailable");
    const tmp = join(dir, `.receipt-${randomUUID()}`);
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(completed));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, file);
      this.syncDir(dir);
    } finally {
      rmSync(tmp, { force: true });
    }
    return completed;
  }
  private syncDir(dir: string): void {
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  status(
    key: string,
    vault: string,
    catalog: ConnectorCatalog,
  ): "absent" | "completed" | "outcome_unknown" {
    const row = this.lookup(key, vault);
    if (!row) return "absent";
    if (row.phase === "completed") return "completed";
    const installed = catalog.list().find((item) => item.id === row.id);
    if (installed?.approval !== "pending" || installed.contentSha256 !== row.contentSha256)
      return "outcome_unknown";
    const loaded = catalog.installed(row.id);
    if (loaded.contentSha256 !== row.contentSha256) return "outcome_unknown";
    this.complete(row, {
      id: row.id,
      status: "pending",
      replaced: row.replaced,
      contentSha256: row.contentSha256,
      module: loaded.manifest.module,
      kind: loaded.manifest.kind,
      hosts: loaded.manifest.fetch?.hosts ?? [],
      secretIds: loaded.manifest.fetch?.secrets.map((item) => item.id) ?? [],
    });
    return "completed";
  }
}
