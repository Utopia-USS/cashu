// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The budget cushion (S31a spec 4.6, D7a): not a DB write, so no outbox row. The daemon compares the
// cushion in `profiles/<slug>/budget.json` with the LAST SHIPPED value (never with the view: a phone
// edit not yet applied to the file must not be overwritten) and, on a difference, ships
// `budgetSettings.cushionSet` built by the genesis mapper. A file edit is a local write stamped at ship
// time, like an outbox row. A missing or invalid file ships nothing.
import type { UnstampedEvent } from "@cashu/sync";
import { canonicalJson } from "../canonical.js";
import { readCushion } from "../genesis/files.js";
import { cushionEvents } from "./map/budget.js";
import { BridgeBlock } from "./map/types.js";
import { validate } from "./plan.js";
import { type BridgePorts, type VaultInput, VaultMapping } from "./resolve.js";

export interface CushionShip {
  /** Canonical JSON of the cushion now in the file (store it as shipped after the write). */
  readonly value: string;
  readonly events: readonly UnstampedEvent[];
}

/** Canonical JSON of the cushion in the file, undefined for a missing or invalid file. */
export function cushionValue(files: VaultInput["files"], slug: string): string | undefined {
  const file = readCushion(files, slug);
  return file.kind === "ok" ? canonicalJson(file.cushion) : undefined;
}

/**
 * The cushion events of one vault when the file's value differs from `lastShipped` (canonical JSON),
 * else undefined. `at` is the ship time (ISO, `Z`).
 */
export function cushionShip(
  vault: VaultInput,
  slug: string,
  lastShipped: string | undefined,
  at: string,
  ports: BridgePorts,
): CushionShip | undefined {
  const file = readCushion(vault.files, slug);
  if (file.kind !== "ok") return undefined;
  const value = canonicalJson(file.cushion);
  if (value === lastShipped) return undefined;
  const vm = new VaultMapping(vault, ports);
  const drafts = cushionEvents(file.cushion, vm.ctx);
  validate(drafts, vm);
  if (drafts.length === 0) throw new BridgeBlock("unresolved:budget_settings");
  const events = drafts.map(
    (d): UnstampedEvent => ({
      t: d.type,
      v: 1,
      i: ports.ulid(),
      g: d.gid,
      a: at,
      d: d.data,
      o: "bridge",
    }),
  );
  return { value, events };
}
