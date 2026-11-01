// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// The plan of one loop iteration (S31a spec 2.4 step 1, 4.2, 4.3, 4.7, 5.2, 6.6): complete outbox
// transactions -> merged rows -> events per linked vault, with
// - the closure snapshot of an instrument a vault starts to reference, prepended to the row's events;
// - shared rows (instruments, aliases: no profile) shipped to every vault that holds the instrument;
// - rows of a profile without a vault acked unshipped (genesis of that profile reads the live state);
// - the causal link of a transaction's side events to its `proposal.*` / `note.candidateUpdated`;
// - the leader filter (TRANSITIONAL(S29c-B1) port): leader-only events dropped on a non-leader;
// - every event validated (`parseEvent` + the DET self-check, genesis `checkEvent`);
// - ONE frame per vault per plan (TRANSITIONAL(S29c-B3)): the engine would split a larger batch into
//   a frame group, and a crash between its appends tears the device's stream for good. Transactions
//   are added while they fit; a first transaction that alone does not fit blocks `needs-batch-append`.
// `through` = the last outbox id of the planned transactions; the ack plan (`ackEntries`) turns each
// event's carried columns into field clocks once the write stamped the HLCs.
import type { UnstampedEvent } from "@cashu/sync";
import { META } from "../events/v1/catalog.js";
import { formatHlc } from "../events/v1/hlc-format.js";
import { genesisDevice } from "../genesis/clock.js";
import { checkEvent } from "../genesis/emit.js";
import type { EventDraft } from "../genesis/map/context.js";
import { BridgeBlock } from "./map/types.js";
import { mapRow } from "./map.js";
import { type LogicalRow, mergeTxn } from "./merge.js";
import { atOf, byTxn, type OutboxRow } from "./outbox.js";
import { type AckGid, type BridgePorts, type VaultInput, VaultMapping } from "./resolve.js";

/** Engine frame defaults (`createSyncEngine` `maxFrameEvents` / `maxFrameBytes`). */
export const FRAME_EVENTS = 1000;
export const FRAME_BYTES = 1024 * 1024;
/** `,"h":"<47-char HLC>"`: what the engine's stamp adds to each event's JSON. */
const HLC_JSON = 54;

/** The Python columns one event carries for one row (the ack clocks). */
export interface CarriedColumns {
  readonly table: string;
  readonly localId: string;
  readonly columns: readonly string[];
}

/** One vault's share of a plan: one frame. */
export interface VaultBatch {
  readonly ordinal: number;
  readonly profileId: number;
  readonly vault: string;
  readonly events: readonly UnstampedEvent[];
  /** Per event (same index): the rows and columns it carries. */
  readonly carries: readonly (readonly CarriedColumns[])[];
  /** Gids the bridge computed (sent with the ack). */
  readonly gids: readonly AckGid[];
}

export interface PlanCounts {
  readonly txns: number;
  readonly rows: number;
  readonly events: number;
  /** Leader-only events dropped on a non-leader device (2.5). */
  readonly notLeader: number;
  /** Rows of profiles without a linked vault: acked, not shipped. */
  readonly unlinked: number;
  /** Shared rows no linked vault holds: acked, not shipped (a later reference ships a snapshot). */
  readonly sharedUnheld: number;
  /** Rows whose change produced no event (derived / device-local columns only, 4.5). */
  readonly noEvent: number;
  /** Instruments shipped as a closure snapshot. */
  readonly closure: number;
}

export interface Plan {
  readonly through: number;
  readonly batches: readonly VaultBatch[];
  readonly counts: PlanCounts;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly reason: string; readonly through: number };

export interface PlanInput {
  /** Unacked local outbox rows in id order, complete transactions only (4.1). */
  readonly rows: readonly OutboxRow[];
  /** Every linked vault, ordinal order. */
  readonly vaults: readonly VaultInput[];
  readonly ports: BridgePorts;
  readonly maxFrameEvents?: number;
  readonly maxFrameBytes?: number;
}

interface Drafted {
  readonly draft: EventDraft;
  readonly at: string;
  readonly carries: CarriedColumns[];
}

interface VaultState {
  readonly vm: VaultMapping;
  readonly events: UnstampedEvent[];
  readonly carries: (readonly CarriedColumns[])[];
  bytes: number;
}

const INSTRUMENT_TABLES: ReadonlySet<string> = new Set([
  "inv_instruments",
  "inv_instrument_aliases",
]);
const CAUSES: readonly string[] = ["proposal.approved", "proposal.rejected", "proposal.failed"];
const NOTE_SIDE = /^(watchlist|thesis)\./;

/** The instrument local id(s) a shared row is about. */
function instrumentsOf(row: LogicalRow): readonly string[] {
  if (row.op === "merge") {
    const k = row.key ?? {};
    return [String(k.source ?? ""), String(k.target ?? "")];
  }
  if (row.table === "inv_instruments") return [row.localId];
  const values = row.post ?? row.fields;
  const id = values.instrument_id;
  return id === null || id === undefined ? [] : [String(id)];
}

/** `parseEvent` + the DET self-check of every draft (genesis `checkEvent`); a failure blocks. */
export function validate(drafts: readonly EventDraft[], vm: VaultMapping): void {
  const device = genesisDevice(vm.input.salt);
  const placeholder = {
    eid: "00000000000000000000000000",
    vault: vm.input.vault,
    device,
    hlc: formatHlc({ wall: 0, counter: 0, device }),
    at: "1970-01-01T00:00:00Z",
    v: 1,
    origin: "bridge",
  };
  for (const d of drafts) {
    if (checkEvent(d, placeholder, vm.det) !== "ok") {
      throw new BridgeBlock(`invalid-event:${d.type}`);
    }
  }
}

class Planner {
  readonly #input: PlanInput;
  readonly #states: VaultState[];
  readonly #byProfile: ReadonlyMap<number, VaultState>;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly counts = {
    txns: 0,
    rows: 0,
    events: 0,
    notLeader: 0,
    unlinked: 0,
    sharedUnheld: 0,
    noEvent: 0,
    closure: 0,
  };

  constructor(input: PlanInput) {
    this.#input = input;
    this.#states = input.vaults.map((v) => ({
      vm: new VaultMapping(v, input.ports),
      events: [],
      carries: [],
      bytes: 0,
    }));
    this.#byProfile = new Map(this.#states.map((s) => [s.vm.input.profileId, s]));
    this.#maxEvents = input.maxFrameEvents ?? FRAME_EVENTS;
    this.#maxBytes = input.maxFrameBytes ?? FRAME_BYTES;
  }

  /** Plans one transaction; false when a vault's frame would overflow (nothing of it kept). */
  addTxn(rows: readonly OutboxRow[]): boolean {
    const drafted = new Map<VaultState, Drafted[]>();
    const push = (s: VaultState, items: readonly Drafted[]) => {
      const list = drafted.get(s) ?? [];
      list.push(...items);
      drafted.set(s, list);
    };
    const logical = mergeTxn(rows);
    for (const row of logical) {
      if (row.profileId === null) {
        if (!INSTRUMENT_TABLES.has(row.table)) throw new BridgeBlock(`no-profile:${row.table}`);
        if (row.op === "insert" && row.table === "inv_instruments") {
          this.counts.sharedUnheld += 1; // shipped as a closure snapshot when a vault references it
          continue;
        }
        const ids = instrumentsOf(row);
        const holders = this.#states.filter((s) => ids.some((id) => s.vm.holdsInstrument(id)));
        if (holders.length === 0) this.counts.sharedUnheld += 1;
        for (const s of holders) push(s, this.#mapped(row, s, logical));
        continue;
      }
      const s = this.#byProfile.get(row.profileId);
      if (s === undefined) {
        this.counts.unlinked += 1;
        continue;
      }
      push(s, this.#mapped(row, s, logical));
    }
    // Wire events per vault, then the frame check over every vault before anything is kept.
    const wired = new Map<VaultState, { events: UnstampedEvent[]; carries: CarriedColumns[][] }>();
    for (const [s, items] of drafted) {
      wired.set(s, this.#wire(s, items));
    }
    for (const [s, w] of wired) {
      const bytes = w.events.reduce((n, e) => n + JSON.stringify(e).length + HLC_JSON, 0);
      if (s.events.length + w.events.length > this.#maxEvents || s.bytes + bytes > this.#maxBytes) {
        return false;
      }
    }
    for (const [s, w] of wired) {
      s.events.push(...w.events);
      s.carries.push(...w.carries);
      s.bytes += w.events.reduce((n, e) => n + JSON.stringify(e).length + HLC_JSON, 0);
      this.counts.events += w.events.length;
    }
    this.counts.txns += 1;
    this.counts.rows += rows.length;
    return true;
  }

  /** One row's events in one vault, after the closure snapshot its references need. */
  #mapped(row: LogicalRow, s: VaultState, txn: readonly LogicalRow[]): Drafted[] {
    const mapped = mapRow(row, s.vm, txn);
    const closure = s.vm.closureEvents();
    this.counts.closure += closure.filter((r) => r.table === "inv_instruments").length;
    const at = atOf(row.ts);
    if (mapped.events.length === 0) this.counts.noEvent += 1;
    const out: Drafted[] = [];
    for (const r of closure) {
      for (const draft of r.events) out.push({ draft, at, carries: [] });
    }
    mapped.events.forEach((draft, i) => {
      const columns = mapped.carries[i] ?? [];
      const carries =
        columns.length > 0 ? [{ table: row.table, localId: row.localId, columns }] : [];
      out.push({ draft, at, carries });
    });
    return out;
  }

  /** Validated wire events of one transaction in one vault (leader filter, causes, eids). */
  #wire(s: VaultState, items: readonly Drafted[]) {
    const vault = s.vm.input.vault;
    const leader = this.#input.ports.isLeader(vault);
    const kept = items.filter((d) => {
      if (leader || META[d.draft.type].emitter !== "leader") return true;
      this.counts.notLeader += 1;
      return false;
    });
    validate(
      kept.map((d) => d.draft),
      s.vm,
    );
    // The cause of a transaction's side effects (events.md 6.6): a proposal decision, else a
    // candidate accept / undo. A caused event must sort AFTER its cause (the store suppresses it
    // otherwise), so the cause moves right after the earlier events of its own row; those (its own
    // row's history) never get it as their cause.
    let causeIndex = kept.findIndex((d) => CAUSES.includes(d.draft.type));
    const byNote = causeIndex < 0;
    if (byNote) causeIndex = kept.findIndex((d) => d.draft.type === "note.candidateUpdated");
    const causeItem = kept[causeIndex];
    const ordered =
      causeItem === undefined
        ? [...kept]
        : [
            ...kept.slice(0, causeIndex).filter((d) => d.draft.gid === causeItem.draft.gid),
            causeItem,
            ...kept.filter(
              (d, i) =>
                i !== causeIndex && !(i < causeIndex && d.draft.gid === causeItem.draft.gid),
            ),
          ];
    const eids = ordered.map(() => this.#input.ports.ulid());
    const causeEid = causeItem === undefined ? undefined : eids[ordered.indexOf(causeItem)];
    const events = ordered.map((d, i): UnstampedEvent => {
      const caused =
        causeItem !== undefined &&
        d !== causeItem &&
        d.draft.gid !== causeItem.draft.gid &&
        (!byNote || NOTE_SIDE.test(d.draft.type));
      return {
        t: d.draft.type,
        v: 1,
        i: eids[i] ?? "",
        g: d.draft.gid,
        a: d.at,
        d: d.draft.data,
        o: "bridge",
        ...(caused && causeEid !== undefined ? { c: causeEid } : {}),
      };
    });
    return { events, carries: ordered.map((d) => d.carries) };
  }

  batches(): VaultBatch[] {
    return this.#states
      .filter((s) => s.events.length > 0 || s.vm.computed.length > 0)
      .map((s) => ({
        ordinal: s.vm.input.ordinal,
        profileId: s.vm.input.profileId,
        vault: s.vm.input.vault,
        events: s.events,
        carries: s.carries,
        gids: [...s.vm.computed],
      }));
  }
}

function planTxns(input: PlanInput, txns: readonly (readonly OutboxRow[])[]) {
  const planner = new Planner(input);
  let planned = 0;
  for (const txn of txns) {
    if (!planner.addTxn(txn)) break;
    planned += 1;
  }
  return { planner, planned };
}

/**
 * The plan of the given complete transactions (as many as fit one frame per vault), or the block
 * that stops the loop (D4: never skipped, never acked). Deterministic but for the injected ULIDs.
 */
export function plan(input: PlanInput): PlanResult {
  const txns = byTxn(input.rows);
  const firstId = input.rows[0]?.id ?? 0;
  try {
    let { planner, planned } = planTxns(input, txns);
    if (planned === 0 && txns.length > 0) {
      return { ok: false, reason: "needs-batch-append", through: firstId };
    }
    if (planned < txns.length) {
      // A plan cut at an overflowing transaction is planned again without it, so no state of the
      // dropped transaction (computed gids, closure) leaks into the kept one.
      ({ planner, planned } = planTxns(input, txns.slice(0, planned)));
    }
    const lastTxn = txns[planned - 1] ?? [];
    const through = lastTxn.at(-1)?.id ?? 0;
    return { ok: true, plan: { through, batches: planner.batches(), counts: planner.counts } };
  } catch (e) {
    if (e instanceof BridgeBlock) return { ok: false, reason: e.reason, through: firstId };
    throw e;
  }
}

/** One Python ack entry (P-A): the computed gid and / or the field clocks of one row. */
export interface AckEntry {
  readonly profile_id: number;
  readonly table: string;
  readonly local_id: string;
  readonly gid?: string;
  readonly clocks?: Readonly<Record<string, readonly [string, string]>>;
}

/**
 * The ack entries of a written plan: computed gids, and per carried column `(hlc, eid)` of the
 * event that carries it (a column carried twice takes the later event). `hlcs` maps every eid of the
 * plan to its stamped HLC (`Store.eventHlcs`); a missing one is a broken invariant.
 */
export function ackEntries(p: Plan, hlcs: ReadonlyMap<string, string>): readonly AckEntry[] {
  const out = new Map<
    string,
    { gid?: string; clocks: Record<string, [string, string]>; e: AckEntry }
  >();
  const entry = (profileId: number, table: string, localId: string) => {
    const k = `${profileId}\u001f${table}\u001f${localId}`;
    let v = out.get(k);
    if (v === undefined) {
      v = { clocks: {}, e: { profile_id: profileId, table, local_id: localId } };
      out.set(k, v);
    }
    return v;
  };
  for (const b of p.batches) {
    for (const g of b.gids) entry(b.profileId, g.table, g.localId).gid = g.gid;
    b.events.forEach((e, i) => {
      const hlc = hlcs.get(e.i);
      if (hlc === undefined) throw new Error("ack plan: an event of the plan has no HLC");
      for (const c of b.carries[i] ?? []) {
        const v = entry(b.profileId, c.table, c.localId);
        for (const col of c.columns) v.clocks[col] = [hlc, e.i];
      }
    });
  }
  return [...out.values()].map((v) => ({
    ...v.e,
    ...(v.gid === undefined ? {} : { gid: v.gid }),
    ...(Object.keys(v.clocks).length === 0 ? {} : { clocks: v.clocks }),
  }));
}
