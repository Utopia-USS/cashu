/** Parity natural-key adapter for the portable S62 gid projector. */
import { GidKeys as SharedGidKeys } from "@cashu/store/genesis/verification";
import { SPECS } from "../../sources/index.ts";
import type { VaultRun } from "./genesisRun.ts";

export interface KeyLookup {
  key(table: string, id: number | bigint): string;
}

export class GidKeys extends SharedGidKeys {
  constructor(vault: Pick<VaultRun, "det" | "sources">, keys: KeyLookup) {
    super(vault, {
      key: (table, id) => keys.key(table, id),
      prefix: (table) => SPECS[table]?.prefix ?? table,
    });
  }
}
