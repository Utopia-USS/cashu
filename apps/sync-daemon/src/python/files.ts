// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 4.3, 4.6).
//
// The Python data dir's side files as genesis reads them (`GenesisFiles`: relative paths with `/`),
// read-only and confined to the data dir. Follow-up (D6): the CLI has the same adapter over its
// copy; both move into @cashu/node-host when a third host needs it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { genesis } from "@cashu/store";

export function dataDirFiles(root: string): genesis.GenesisFiles {
  const base = resolve(root);
  const inside = (rel: string): string | undefined => {
    const full = resolve(join(base, ...rel.split("/")));
    return full.startsWith(`${base}${sep}`) ? full : undefined;
  };
  return {
    read(rel) {
      const full = inside(rel);
      if (full === undefined || !existsSync(full) || !statSync(full).isFile()) return undefined;
      return new Uint8Array(readFileSync(full));
    },
    list(dir) {
      const full = inside(dir);
      if (full === undefined || !existsSync(full) || !statSync(full).isDirectory()) return [];
      return readdirSync(full).sort();
    },
  };
}
