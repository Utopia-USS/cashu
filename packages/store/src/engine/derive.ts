// Derivers (S24 4.1): post-fold steps that recompute derived columns and rows (events.md 9) from the
// output of several materializers. The materializer runners record the partitions they folded in an
// apply (`DirtyCollector`); after every materializer ran, each deriver whose inputs are dirty runs in
// registry order inside the same transaction: `deriveAll` when an input is `"all"`, else `derive` on
// the dirty partitions. A rebuild runs every `deriveAll` once, after the full re-fold.
import type { PaymentPattern } from "@cashu/domain/core";
import type { DetGid } from "../gid.js";
import type { ViewIds } from "./context.js";
import type { IdentityService } from "./identity.js";
import {
  CONTRIBUTIONS,
  type Contributions,
  type DeriveContext,
  type Deriver,
  type DirtyPartitions,
  type ModuleContributions,
  type ViewSql,
} from "./types.js";

/** The dirty partitions of one apply, per input id. */
export class DirtyCollector {
  readonly #map = new Map<string, Set<string> | "all">();

  add(input: string, partitions: Iterable<string>): void {
    const prev = this.#map.get(input);
    if (prev === "all") return;
    const set = prev ?? new Set<string>();
    for (const p of partitions) set.add(p);
    this.#map.set(input, set);
  }

  all(input: string): void {
    this.#map.set(input, "all");
  }

  get partitions(): DirtyPartitions {
    return this.#map;
  }
}

export interface DeriveDeps {
  readonly det: DetGid;
  readonly ids: ViewIds;
  readonly identity: IdentityService;
  readonly contributions: readonly ModuleContributions[];
  readonly companionReads: boolean;
}

function contributionsOf(list: readonly ModuleContributions[], sql: ViewSql): Contributions {
  return {
    paymentPatterns(): readonly PaymentPattern[] {
      return list.flatMap((c) => c.paymentPatterns?.(sql) ?? []);
    },
    notSubscriptionCategories(): ReadonlySet<string> {
      return new Set(list.flatMap((c) => c.notSubscriptionCategories ?? []));
    },
  };
}

export function deriveContext(deps: DeriveDeps, sql: ViewSql): DeriveContext {
  return {
    sql,
    det: deps.det,
    id: (gid) => deps.ids.id(gid),
    resolve: (kind, gid) => deps.identity.resolve(kind, gid),
    identityMembers: (kind, root) => deps.identity.members(kind, root),
    contributions: contributionsOf(deps.contributions, sql),
    companionReads: deps.companionReads,
  };
}

/**
 * Mark `CONTRIBUTIONS` dirty when this apply touched a table a module contribution reads (Python
 * `modules.recategorize` after a loan change).
 */
export function markContributions(
  dirty: DirtyCollector,
  touched: ReadonlySet<string>,
  contributions: readonly ModuleContributions[],
): void {
  if (contributions.some((c) => c.reads.some((t) => touched.has(t)))) dirty.all(CONTRIBUTIONS);
}

/** Run every deriver whose inputs are dirty, in order (each sees the previous ones' writes). */
export function runDerivers(
  derivers: readonly Deriver[],
  dirty: DirtyPartitions,
  ctx: DeriveContext,
): void {
  for (const d of derivers) {
    const mine = new Map<string, ReadonlySet<string> | "all">();
    for (const input of d.inputs) {
      const p = dirty.get(input);
      if (p !== undefined) mine.set(input, p);
    }
    if (mine.size === 0) continue;
    if ([...mine.values()].some((p) => p === "all")) d.deriveAll(ctx);
    else d.derive(mine, ctx);
    ctx.sql.flush();
  }
}

/** Every deriver's full derivation (rebuild, upgrade). */
export function deriveEverything(derivers: readonly Deriver[], ctx: DeriveContext): void {
  for (const d of derivers) {
    d.deriveAll(ctx);
    ctx.sql.flush();
  }
}
