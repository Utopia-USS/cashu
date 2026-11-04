/** Read the shipped public catalogue; refuse copied datasets with installed connector code. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NativeToolStore } from "@cashu/mcp";
import type { PythonDb } from "../../sources/index.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "connectors");

function field(source: string, key: string): string | null {
  const line = source.split(/\r?\n/u).find((value) => value.startsWith(`${key}: `));
  if (!line) return null;
  const raw = line.slice(key.length + 2).trim();
  return raw.replace(/^(?:'(.*)'|"(.*)")$/u, "$1$2");
}

function contentHash(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("shipped connector catalogue contains a link");
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else if (stat.isFile()) {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        entries.push(`${prefix}${name}\0${digest}\n`);
      } else throw new Error("shipped connector catalogue contains a special file");
    }
  };
  walk(root, "");
  return createHash("sha256").update(entries.sort().join(""), "utf8").digest("hex");
}

function catalogue(
  today: string,
): Awaited<ReturnType<NonNullable<NativeToolStore["connectors"]>["list"]>>["catalog"] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(ROOT, entry.name);
      const manifest = readFileSync(join(dir, "connector.yaml"), "utf8");
      const id = field(manifest, "id");
      const name = field(manifest, "name");
      const module = field(manifest, "module");
      const kind = field(manifest, "kind");
      const version = field(manifest, "version");
      const maintainer = field(manifest, "maintainer");
      const lastVerified = field(manifest, "last_verified");
      if (
        id !== entry.name ||
        !name ||
        !module ||
        !kind ||
        !version ||
        !maintainer ||
        !lastVerified ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(lastVerified) ||
        !lstatSync(join(dir, "README.md")).isFile() ||
        readdirSync(join(dir, "fixtures")).length === 0
      )
        throw new Error("shipped connector catalogue needs a complete manifest");
      const age = Math.floor(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastVerified}T00:00:00Z`)) / 86_400_000,
      );
      return {
        id,
        name,
        module,
        kind,
        version,
        maintainer,
        lastVerified,
        contentSha256: contentHash(dir),
        stale: age > 180,
        valid: age >= -1,
        installedStatus: null,
        installedSameContent: null,
      };
    });
}

export function bindConnectorReads(
  db: PythonDb,
  profileId: number,
): NonNullable<NativeToolStore["connectors"]> {
  return {
    async list() {
      if (!db.connectorInventoryEmpty(profileId))
        throw new Error("copied installed connector code needs a typed parity adapter");
      return { installed: [], catalog: catalogue(db.asOf) };
    },
    async testFile() {
      throw new Error("MCP read parity attempted connector test");
    },
    async propose() {
      throw new Error("MCP read parity attempted connector proposal");
    },
  };
}
