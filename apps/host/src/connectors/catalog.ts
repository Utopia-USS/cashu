import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ConnectorFault, type LoadedConnector, scanConnector } from "./manifest.js";

const approvalSchema = z.strictObject({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  interpreter: z.string().min(1),
  approvedAt: z.string().datetime(),
  status: z.enum(["approved", "disabled"]),
});
export type ConnectorApproval = z.infer<typeof approvalSchema>;
export interface OwnerApproval {
  readonly ownerAction: true;
  readonly isCurrent: () => boolean;
}

export interface InstalledConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "fetch";
  readonly module: "budget" | "investments";
  readonly contentSha256: string;
  readonly interpreter: string | null;
  readonly approval: "approved" | "pending" | "changed" | "disabled";
}

function privateDirectory(path: string, create = false): { dev: number; ino: number } {
  try {
    if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700, recursive: true });
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      realpathSync.native(path) !== resolve(path)
    )
      throw new Error("unsafe directory");
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    throw new ConnectorFault("invalid_directory", "private connector directory unavailable");
  }
}

function safeId(id: string): string {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id) || id === "catalog")
    throw new ConnectorFault("invalid_manifest", "invalid connector id");
  return id;
}

/** The caller supplies an authorized app data directory, never a source/catalog path. */
export class ConnectorCatalog {
  readonly root: string;
  private readonly pin: { dev: number; ino: number };
  constructor(
    dataDir: string,
    readonly bundledDeno?: string,
  ) {
    if (!dataDir || !resolve(dataDir).startsWith("/"))
      throw new ConnectorFault("invalid_directory", "app data directory required");
    privateDirectory(dataDir);
    this.root = join(resolve(dataDir), "installed-connectors");
    this.pin = privateDirectory(this.root, true);
  }

  private checkRoot(): void {
    const current = privateDirectory(this.root);
    if (current.dev !== this.pin.dev || current.ino !== this.pin.ino)
      throw new ConnectorFault("changed", "installed connector directory changed");
  }

  /** Pin check for host-owned auxiliary files under this private catalog directory. */
  assertCurrentRoot(): void {
    this.checkRoot();
  }

  /** A durable owner removal fence blocks new code or execution until reconciliation finishes. */
  removalActive(id: string): boolean {
    this.checkRoot();
    try {
      lstatSync(join(this.root, `.removing-${safeId(id)}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private checkNotRemoving(id: string): void {
    if (this.removalActive(id))
      throw new ConnectorFault("changed", "connector removal in progress");
  }

  private code(id: string): string {
    return join(this.root, safeId(id));
  }
  private approval(id: string): string {
    return join(this.root, `${safeId(id)}.approval.json`);
  }

  private readApproval(id: string): ConnectorApproval {
    const path = this.approval(id);
    if (!existsSync(path)) throw new ConnectorFault("changed", "connector has no owner approval");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0)
      throw new ConnectorFault("changed", "approval record invalid");
    try {
      return approvalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw new ConnectorFault("changed", "approval record invalid");
    }
  }

  /** Install from an untrusted workspace/catalog as pending; this does not grant execution. */
  installPending(source: string): LoadedConnector {
    this.checkRoot();
    const sourceImage = scanConnector(source);
    const id = sourceImage.manifest.id;
    this.checkNotRemoving(id);
    const target = this.code(id);
    const staging = join(this.root, `.pending-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      for (const entry of sourceImage.files) {
        const from = join(sourceImage.root, entry.path);
        const to = join(staging, entry.path);
        privateDirectory(join(to, ".."), true);
        const stat = lstatSync(from);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size)
          throw new ConnectorFault("changed", "source changed during install");
        copyFileSync(from, to, constants.COPYFILE_EXCL);
        chmodSync(to, entry.executable ? 0o700 : 0o600);
      }
      const staged = scanConnector(staging);
      if (staged.contentSha256 !== sourceImage.contentSha256)
        throw new ConnectorFault("changed", "source changed during install");
      this.checkNotRemoving(id);
      // Existing approval is invalidated before replacing installed code.
      rmSync(this.approval(id), { force: true });
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      return scanConnector(target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  installed(id: string): LoadedConnector {
    this.checkRoot();
    const path = this.code(id);
    if (!existsSync(path)) throw new ConnectorFault("missing", "connector is not installed");
    const loaded = scanConnector(path);
    if (loaded.manifest.id !== id)
      throw new ConnectorFault("changed", "installed connector id changed");
    return loaded;
  }

  /** Bounded, value-free installed inventory for owner Settings. */
  list(): readonly InstalledConnectorSummary[] {
    this.checkRoot();
    const entries = readdirSync(this.root, { withFileTypes: true });
    if (entries.length > 200)
      throw new ConnectorFault("invalid_directory", "connector inventory exceeds limit");
    const result: InstalledConnectorSummary[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;
      if (result.length >= 100)
        throw new ConnectorFault("invalid_directory", "connector inventory exceeds limit");
      const loaded = this.installed(safeId(entry.name));
      let interpreter: string | null = null;
      try {
        interpreter = resolveInterpreter(loaded, this.bundledDeno);
      } catch {
        // An unavailable interpreter is shown as such; approval cannot execute.
      }
      let approval: InstalledConnectorSummary["approval"] = "pending";
      if (existsSync(this.approval(entry.name))) {
        approval = "changed";
        try {
          if (this.readApproval(entry.name).status === "disabled") approval = "disabled";
          else if (interpreter) {
            this.approved(entry.name, interpreter);
            approval = "approved";
          }
        } catch {
          // A changed approval is visible but not executable.
        }
      }
      result.push({
        id: entry.name,
        name: loaded.manifest.name,
        kind: loaded.manifest.kind,
        module: loaded.manifest.module,
        contentSha256: loaded.contentSha256,
        interpreter,
        approval,
      });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Only a live owner UI capability may approve an exact installed digest and resolved interpreter. */
  approve(
    id: string,
    expectedContentSha256: string,
    interpreter: string,
    authority: OwnerApproval,
  ): ConnectorApproval {
    if (authority.ownerAction !== true || !authority.isCurrent())
      throw new ConnectorFault("changed", "owner authority unavailable");
    this.checkNotRemoving(id);
    const loaded = this.installed(id);
    if (loaded.contentSha256 !== expectedContentSha256)
      throw new ConnectorFault("changed", "connector changed before approval");
    const realInterpreter = realpathSync.native(interpreter);
    if (realInterpreter !== resolveInterpreter(loaded, this.bundledDeno))
      throw new ConnectorFault("invalid_manifest", "interpreter does not match manifest");
    const stat = lstatSync(realInterpreter);
    if (!stat.isFile() || !realInterpreter.startsWith("/") || (stat.mode & 0o111) === 0)
      throw new ConnectorFault("invalid_manifest", "interpreter unavailable");
    const approval = approvalSchema.parse({
      contentSha256: loaded.contentSha256,
      interpreter: realInterpreter,
      approvedAt: new Date().toISOString(),
      status: "approved",
    });
    const temporary = join(this.root, `.approval-${randomUUID()}`);
    try {
      writeFileSync(temporary, JSON.stringify(approval), { mode: 0o600, flag: "wx" });
      if (
        !authority.isCurrent() ||
        this.removalActive(id) ||
        this.installed(id).contentSha256 !== loaded.contentSha256
      )
        throw new ConnectorFault("changed", "approval source changed");
      renameSync(temporary, this.approval(id));
      return approval;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  disable(id: string, authority: OwnerApproval): void {
    if (authority.ownerAction !== true || !authority.isCurrent())
      throw new ConnectorFault("changed", "owner authority unavailable");
    this.checkNotRemoving(id);
    const loaded = this.installed(id);
    const approval = this.readApproval(id);
    if (approval.status !== "approved" || approval.contentSha256 !== loaded.contentSha256)
      throw new ConnectorFault("changed", "connector approval changed");
    const temporary = join(this.root, `.approval-${randomUUID()}`);
    try {
      writeFileSync(temporary, JSON.stringify({ ...approval, status: "disabled" }), {
        mode: 0o600,
        flag: "wx",
      });
      if (!authority.isCurrent() || this.installed(id).contentSha256 !== loaded.contentSha256)
        throw new ConnectorFault("changed", "approval source changed");
      renameSync(temporary, this.approval(id));
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** CLI removal is deliberately limited to a connector with no binding or run-history references. */
  removeUnbound(
    id: string,
    authority: OwnerApproval,
    noReferences: () => boolean,
    options: { readonly allowRemovalFence?: boolean } = {},
  ): void {
    if (authority.ownerAction !== true || !authority.isCurrent())
      throw new ConnectorFault("changed", "owner authority unavailable");
    if (this.removalActive(id) && options.allowRemovalFence !== true)
      throw new ConnectorFault("changed", "connector removal in progress");
    const loaded = this.installed(id);
    if (!noReferences()) throw new ConnectorFault("changed", "connector references remain");
    const target = this.code(id);
    const quarantine = join(this.root, `.removed-${randomUUID()}`);
    this.checkRoot();
    if (
      !authority.isCurrent() ||
      (this.removalActive(id) && options.allowRemovalFence !== true) ||
      !noReferences() ||
      this.installed(id).contentSha256 !== loaded.contentSha256
    )
      throw new ConnectorFault("changed", "connector changed before removal");
    renameSync(target, quarantine);
    try {
      rmSync(this.approval(id), { force: true });
    } finally {
      rmSync(quarantine, { recursive: true, force: true });
    }
  }

  approved(id: string, interpreter: string): LoadedConnector {
    this.checkNotRemoving(id);
    const loaded = this.installed(id);
    const approval = this.readApproval(id);
    if (approval.status !== "approved")
      throw new ConnectorFault("changed", "connector disabled by owner");
    const resolved = realpathSync.native(interpreter);
    if (resolved !== resolveInterpreter(loaded, this.bundledDeno))
      throw new ConnectorFault("changed", "interpreter no longer resolves from manifest");
    if (approval.contentSha256 !== loaded.contentSha256)
      throw new ConnectorFault("changed", "connector code changed after approval");
    if (approval.interpreter !== resolved)
      throw new ConnectorFault("changed", "interpreter changed after approval");
    return loaded;
  }
}

/** Fixed search path. The host may pass only its verified app-bundled Deno path. */
export function resolveInterpreter(loaded: LoadedConnector, bundledDeno?: string): string {
  const first = loaded.manifest.run[0];
  if (!first) throw new ConnectorFault("invalid_manifest", "interpreter missing");
  if (first.startsWith("./")) {
    const entry = loaded.files.find((file) => file.path === first.slice(2));
    if (!entry?.executable)
      throw new ConnectorFault("invalid_manifest", "connector executable missing");
    return realpathSync.native(join(loaded.root, first));
  }
  const candidates =
    first === "deno"
      ? [
          ...(bundledDeno ? [bundledDeno] : []),
          "/opt/homebrew/bin/deno",
          "/usr/local/bin/deno",
          "/usr/bin/deno",
        ]
      : [
          `/opt/homebrew/bin/${first}`,
          `/usr/local/bin/${first}`,
          `/usr/bin/${first}`,
          `/bin/${first}`,
        ];
  for (const path of candidates) {
    try {
      const real = realpathSync.native(path);
      const stat = lstatSync(real);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const bytes = Buffer.alloc(2);
      let count: number;
      try {
        count = readSync(fd, bytes, 0, 2, 0);
      } finally {
        closeSync(fd);
      }
      const head = bytes.subarray(0, count).toString();
      if (head === "#!") continue;
      return real;
    } catch {
      /* try next fixed location */
    }
  }
  throw new ConnectorFault("missing", "interpreter unavailable");
}
