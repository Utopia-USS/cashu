import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_FILES = 200;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const nofollow = constants.O_NOFOLLOW ?? 0;
const nonblock = constants.O_NONBLOCK ?? 0;
const id = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const label = z.string().trim().min(1).max(60);
const secret = z.strictObject({ id, label });
const param = z.strictObject({
  id,
  label,
  type: z.enum(["string", "date", "number", "boolean"]).default("string"),
  required: z.boolean().default(false),
});
const file = z.strictObject({
  extensions: z
    .array(z.string().regex(/^[a-z0-9]{1,10}$/))
    .min(1)
    .max(20),
});
const fetch = z.strictObject({
  hosts: z
    .array(
      z
        .string()
        .regex(
          /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        ),
    )
    .min(1)
    .max(10),
  secrets: z.array(secret).max(5).default([]),
  params: z.array(param).max(10).default([]),
  history_days: z.number().int().min(1).max(3650).default(365),
});
export const manifestSchema = z
  .strictObject({
    api_version: z.literal(1),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .refine((value) => value !== "catalog"),
    name: label,
    version: z.string().trim().min(1).max(20),
    author: z.string().trim().min(1).max(80).nullable().optional(),
    description: z.string().trim().min(1).max(280).nullable().optional(),
    maintainer: z.string().trim().min(1).max(80).nullable().optional(),
    last_verified: z.iso.date().nullable().optional(),
    module: z.enum(["investments", "budget"]),
    kind: z.enum(["file", "fetch"]),
    run: z.array(z.string().min(1).max(200)).min(1).max(8),
    timeout_s: z.number().int().min(1).max(600).default(60),
    file: file.nullable().optional(),
    fetch: fetch.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.kind === "file") !== (value.file != null) ||
      (value.kind === "fetch") !== (value.fetch != null)
    )
      ctx.addIssue({ code: "custom", message: "kind and section mismatch" });
    const first = value.run[0];
    if (
      !first ||
      !(
        first.startsWith("./") || ["python3", "node", "deno", "bun", "ruby", "perl"].includes(first)
      )
    )
      ctx.addIssue({ code: "custom", message: "invalid interpreter" });
    if (first?.startsWith("./") && (first.length === 2 || first.includes("=")))
      ctx.addIssue({ code: "custom", message: "invalid executable" });
    if (
      first === "deno" &&
      (!value.run[1] || value.run[1].startsWith("-") || value.run[1] === "run")
    )
      ctx.addIssue({ code: "custom", message: "Deno script required" });
    for (const arg of value.run)
      if (
        [...arg].some((char) => char.charCodeAt(0) < 32) ||
        arg.startsWith("/") ||
        arg.startsWith("~") ||
        arg.replaceAll("\\", "/").split("/").includes("..") ||
        /%2e|%2f|%5c/i.test(arg)
      )
        ctx.addIssue({ code: "custom", message: "unsafe run argument" });
    if (value.fetch)
      for (const values of [
        value.fetch.hosts,
        value.fetch.secrets.map((item) => item.id),
        value.fetch.params.map((item) => item.id),
      ])
        if (new Set(values).size !== values.length)
          ctx.addIssue({ code: "custom", message: "duplicate fetch setting" });
  });
export type ConnectorManifest = z.infer<typeof manifestSchema>;

export class ConnectorFault extends Error {
  constructor(
    readonly kind: "invalid_manifest" | "invalid_directory" | "changed" | "missing",
    message: string,
  ) {
    super(message);
  }
}
export interface FileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}
export interface LoadedConnector {
  readonly root: string;
  readonly manifest: ConnectorManifest;
  readonly files: readonly FileEntry[];
  readonly contentSha256: string;
}

function boundedFile(
  path: string,
  limit: number,
): { bytes: Buffer; mode: number; dev: number; ino: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit)
    throw new ConnectorFault("invalid_directory", "unsafe or oversized file");
  const fd = openSync(path, constants.O_RDONLY | nofollow | nonblock);
  try {
    const stat = lstatSync(path);
    if (stat.dev !== before.dev || stat.ino !== before.ino)
      throw new ConnectorFault("changed", "file changed while opening");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) throw new ConnectorFault("invalid_directory", "oversized file");
      chunks.push(chunk.subarray(0, n));
    }
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== total ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new ConnectorFault("changed", "file changed while reading");
    return {
      bytes: Buffer.concat(chunks, total),
      mode: before.mode,
      dev: before.dev,
      ino: before.ino,
    };
  } finally {
    closeSync(fd);
  }
}

export function parseManifest(bytes: Buffer): ConnectorManifest {
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new ConnectorFault("invalid_manifest", "manifest too large");
  try {
    const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
    if (document.errors.length) throw new Error("YAML parse failed");
    return manifestSchema.parse(document.toJS());
  } catch {
    throw new ConnectorFault("invalid_manifest", "invalid connector manifest");
  }
}

export function scanConnector(root: string): LoadedConnector {
  const directory = resolve(root);
  const base = lstatSync(directory);
  if (!base.isDirectory() || realpathSync.native(directory) !== directory)
    throw new ConnectorFault("invalid_directory", "unsafe connector directory");
  const files: FileEntry[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = `${prefix}${name}`;
      if (name.startsWith(".") && name !== ".gitignore")
        throw new ConnectorFault("invalid_directory", "hidden path");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (stat.nlink > 1 && !stat.isDirectory()))
        throw new ConnectorFault("invalid_directory", "link in connector");
      if (stat.isDirectory()) {
        walk(path, `${rel}/`);
        continue;
      }
      if (!stat.isFile())
        throw new ConnectorFault("invalid_directory", "special file in connector");
      if (files.length >= MAX_FILES || total + stat.size > MAX_TOTAL_BYTES)
        throw new ConnectorFault("invalid_directory", "connector directory limit");
      const read = boundedFile(path, MAX_TOTAL_BYTES - total);
      total += read.bytes.length;
      files.push({
        path: rel,
        size: read.bytes.length,
        sha256: createHash("sha256").update(read.bytes).digest("hex"),
        executable: Boolean(read.mode & 0o100),
      });
    }
  };
  walk(directory, "");
  const manifestFile = files.find((entry) => entry.path === "connector.yaml");
  if (!manifestFile) throw new ConnectorFault("missing", "connector.yaml missing");
  const manifest = parseManifest(
    boundedFile(join(directory, "connector.yaml"), MAX_MANIFEST_BYTES).bytes,
  );
  const script =
    manifest.run[0] === "deno"
      ? manifest.run[1]
      : manifest.run[0]?.startsWith("./")
        ? manifest.run[0].slice(2)
        : undefined;
  if (script && !files.some((entry) => entry.path === script.replace(/^\.\//, "")))
    throw new ConnectorFault("invalid_manifest", "entry script missing");
  const contentSha256 = createHash("sha256")
    .update(
      files
        .map((entry) => `${entry.path}\0${entry.sha256}\n`)
        .sort()
        .join(""),
    )
    .digest("hex");
  return { root: directory, manifest, files, contentSha256 };
}

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
