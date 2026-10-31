// Bridge between the reference fold (`events/v1/reference/fold.ts`) and the store: maps the shared
// scenarios' synthetic names to valid gids, and projects the store's view back into the reference's
// `RefView` shape. Synthetic data only.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { detPartsOf } from "../events/v1/det-parts.js";
import type { RefDet, RefEvent, RefView } from "../events/v1/reference/fold.js";
import { detGid, detGidFor } from "../gid.js";
import type { Store } from "../materialize.js";
import { eventTimestamp } from "../sql/values.js";
import { TEST_SALT, TEST_VAULT, type TestEnvelope, testUlid } from "./store.js";

// --------------------------------------------------------------------------------------------- //
// Names <-> gids

export class Names {
  readonly #toGid = new Map<string, string>();
  readonly #toName = new Map<string, string>();
  #n = 0;

  gid(name: string): string {
    let g = this.#toGid.get(name);
    if (g === undefined) {
      if (name.startsWith("cashleg:")) {
        g = detGid(TEST_SALT, "transactions", ["cashleg", this.gid(name.slice(8))]);
      } else {
        this.#n += 1;
        g = testUlid("01JD", this.#n);
      }
      this.#toGid.set(name, g);
      this.#toName.set(g, name);
    }
    return g;
  }

  /** Bind a name to a deterministic gid (computed from its payload, as a writer would). */
  bind(name: string, gid: string): void {
    const prev = this.#toGid.get(name);
    if (prev !== undefined && prev !== gid) {
      throw new Error(`scenario names ${name} for two different row keys`);
    }
    this.#toGid.set(name, gid);
    this.#toName.set(gid, name);
  }

  name(gid: string): string {
    return this.#toName.get(gid) ?? gid;
  }

  readonly #hashes = new Map<string, string>();

  /** A sha1-shaped stand-in for a synthetic dedup hash name. */
  hash(name: string): string {
    const h = bytesToHex(sha256(utf8ToBytes(name))).slice(0, 40);
    this.#hashes.set(h, name);
    return h;
  }

  hashName(hash: string): string {
    return this.#hashes.get(hash) ?? hash;
  }

  key(key: string, dir: "gid" | "name"): string {
    return key
      .split("|")
      .map((p) =>
        p.startsWith("i:") || p.startsWith("a:")
          ? `${p.slice(0, 2)}${dir === "gid" ? this.gid(p.slice(2)) : this.name(p.slice(2))}`
          : p,
      )
      .join("|");
  }
}

/**
 * Map a scenario to envelopes. An event whose gid is payload-derived (events.md 7.10) and valid under
 * the scenario's DET gets the real DET gid of its mapped payload (a first pass binds those names); an
 * invalid one keeps whatever its name maps to (a valid binding or a ULID), which differs from its
 * real DET, so the store parks it as the reference does. Everything else gets a ULID.
 */
export function toEnvelopes(
  events: readonly RefEvent[],
  names: Names,
  synthetic: RefDet,
): TestEnvelope[] {
  const det = detGidFor(TEST_SALT);
  for (const e of events) {
    const p = detPartsOf(e.type, e.data);
    if (p === undefined || synthetic(p.table, p.parts) !== e.gid) continue;
    const real = detPartsOf(e.type, mapData(e, names));
    if (real !== undefined) names.bind(e.gid, det(real.table, real.parts));
  }
  return events.map((e) => toEnvelope(e, names, mapData(e, names)));
}

function mapData(e: RefEvent, names: Names): Record<string, unknown> {
  const d: Record<string, unknown> = { ...e.data };
  for (const f of ["account", "instrument", "source", "target"]) {
    if (typeof d[f] === "string" && !(e.type === "proposal.created" && f === "source")) {
      if (!(f === "source" && e.type !== "instrument.merged")) d[f] = names.gid(String(d[f]));
    }
  }
  if (Array.isArray(d.signals)) d.signals = (d.signals as string[]).map((s) => names.gid(s));
  if (typeof d.dedupKey === "string") d.dedupKey = names.key(d.dedupKey, "gid");
  if (typeof d.dedupHash === "string") d.dedupHash = names.hash(d.dedupHash);
  return d;
}

function toEnvelope(e: RefEvent, names: Names, d: Record<string, unknown>): TestEnvelope {
  return {
    eid: e.eid,
    vault: TEST_VAULT,
    device: e.hlc.slice(15),
    hlc: e.hlc,
    at: e.at,
    type: e.type,
    v: 1,
    gid: names.gid(e.gid),
    data: d,
    ...(e.cause === undefined ? {} : { cause: e.cause }),
  };
}

// --------------------------------------------------------------------------------------------- //
// The store's view in the reference's shape

export function project(store: Store, names: Names): RefView {
  const n = (g: string) => names.name(g);
  const rec = <T>(entries: [string, T][]) =>
    Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const gidById = new Map(
    store
      .read<{ id: number; gid: string }>("SELECT id, gid FROM view_ids")
      .map((r) => [r.id, r.gid]),
  );
  const members = (materializer: string, partition: string, role?: string) =>
    store
      .read<{ subject: string; role: string | null }>(
        `SELECT subject, role FROM members_${materializer.replace(".", "_")} WHERE partition = ?`,
        partition,
      )
      .filter((m) => role === undefined || m.role === role)
      .map((m) => n(m.subject))
      .sort();
  const identityMembers = (kind: string, root: string) =>
    [
      root,
      ...store
        .read<{ gid: string }>(
          "SELECT gid FROM identity_roots WHERE kind = ? AND root = ?",
          kind,
          root,
        )
        .map((r) => r.gid),
    ]
      .map(n)
      .sort();

  const accounts = store
    .read<{ gid: string; iban: string | null; external_id: string | null; name: string }>(
      "SELECT gid, iban, external_id, name FROM accounts",
    )
    .map((r): [string, RefView["accounts"][string]] => [
      n(r.gid),
      {
        gid: n(r.gid),
        iban: r.iban,
        externalId: r.external_id,
        name: r.name,
        members: identityMembers("accounts", r.gid),
      },
    ]);

  // Transaction members are not indexed (each gid maps to its row through its own import): the
  // applied imports of the log, keyed by their resolved row key.
  const rootOf = new Map(
    store
      .read<{ gid: string; root: string }>(
        "SELECT gid, root FROM identity_roots WHERE kind = 'accounts'",
      )
      .map((r) => [r.gid, r.root]),
  );
  const txnMembers = new Map<string, string[]>();
  for (const r of store.read<{ gid: string; data: string }>(
    "SELECT gid, data FROM event_log WHERE type = 'txn.imported' AND state = 'applied'",
  )) {
    const d = JSON.parse(r.data) as { account: string; dedupHash: string; occurrence: number };
    const key = `${rootOf.get(d.account) ?? d.account}|${d.dedupHash}|${d.occurrence}`;
    const list = txnMembers.get(key) ?? [];
    if (!list.includes(n(r.gid))) list.push(n(r.gid));
    txnMembers.set(key, list);
  }

  const txRows = store.read<{
    gid: string;
    account_id: number;
    dedup_hash: string;
    occurrence: number;
  }>("SELECT gid, account_id, dedup_hash, occurrence FROM transactions");
  const transactions = txRows.map((r): [string, RefView["transactions"][string]] => {
    const root = gidById.get(r.account_id) ?? "";
    const partition = `${root}|${r.dedup_hash}|${r.occurrence}`;
    const c = store.read<{
      claim: string | null;
      claim_by: string | null;
      leg_claim: string | null;
    }>(
      "SELECT claim, claim_by, leg_claim FROM fold_transaction_claims WHERE partition = ?",
      partition,
    )[0];
    const leg =
      c?.claim === "cash_withdrawal" && c.claim_by === "manual_txn"
        ? { gid: `cashleg:${n(r.gid)}`, claim: c.leg_claim }
        : null;
    return [
      `${n(root)}|${names.hashName(r.dedup_hash)}|${r.occurrence}`,
      {
        gid: n(r.gid),
        members: [...(txnMembers.get(partition) ?? [])].sort(),
        claim: c?.claim ?? null,
        leg,
      },
    ];
  });

  const watchlist = store
    .read<{
      gid: string;
      instrument_id: number;
      note: string | null;
      tags: string;
      source: string;
      added_at: string;
      removed_at: string | null;
    }>("SELECT * FROM watchlist_items")
    .map((r): [string, RefView["watchlist"][string]] => {
      const root = gidById.get(r.instrument_id) ?? "";
      return [
        n(root),
        {
          gid: n(r.gid),
          members: members("investments.watchlist", root),
          live: r.removed_at === null,
          note: r.note,
          tags: JSON.parse(r.tags) as string[],
          addedAt: eventTimestamp(r.added_at),
          source: r.source,
        },
      ];
    });

  const overrides = store
    .read<{
      instrument_id: number;
      segment: string | null;
      segment_by: string | null;
      tags: string | null;
    }>("SELECT instrument_id, segment, segment_by, tags FROM inv_profile_instruments")
    .map((r): [string, RefView["overrides"][string]] => [
      n(gidById.get(r.instrument_id) ?? ""),
      {
        segment: r.segment,
        segmentBy: r.segment_by,
        tags: r.tags === null ? null : JSON.parse(r.tags),
      },
    ]);

  const valuations = store
    .read<{ instrument_id: number; as_of: string; unit_value: string }>(
      "SELECT instrument_id, as_of, unit_value FROM inv_manual_valuations",
    )
    .map((r): [string, string] => [
      `${n(gidById.get(r.instrument_id) ?? "")}|${r.as_of}`,
      r.unit_value,
    ]);

  const signals = store
    .read<{
      id: number;
      gid: string;
      dedup_key: string;
      status: RefView["signals"][string]["status"];
      message: string;
      snoozed_until: string | null;
    }>("SELECT id, gid, dedup_key, status, message, snoozed_until FROM inv_signals")
    .map((r): [string, RefView["signals"][string]] => [
      n(r.gid),
      {
        gid: n(r.gid),
        key: names.key(r.dedup_key, "name"),
        status: r.status,
        closedReason:
          store.read<{ closed_reason: string | null }>(
            "SELECT closed_reason FROM fold_signal_episodes WHERE gid = ?",
            r.gid,
          )[0]?.closed_reason ?? null,
        snoozedUntil: eventTimestamp(r.snoozed_until),
        message: r.message,
        aliases: store
          .read<{ gid: string }>(
            "SELECT gid FROM fold_signal_aliases WHERE episode = ? AND gid != episode",
            r.gid,
          )
          .map((a) => n(a.gid))
          .sort(),
        decisions: store
          .read<{ gid: string }>(
            "SELECT d.gid FROM inv_decision_signals l JOIN inv_decisions d ON d.id = l.decision_id WHERE l.signal_id = ?",
            r.id,
          )
          .map((x) => n(x.gid))
          .sort(),
      },
    ]);

  const proposals = store
    .read<{ gid: string; status: string }>("SELECT gid, status FROM proposals")
    .map((r): [string, string] => [n(r.gid), r.status]);

  const bindings = store
    .read<{
      account: string;
      connector_id: string;
      live: number;
      params_json: string;
      cursor: string | null;
    }>("SELECT account, connector_id, live, params_json, cursor FROM fold_connector_bindings")
    .map((r): [string, RefView["bindings"][string]] => [
      `${n(r.account)}|${r.connector_id}`,
      { live: r.live === 1, params: JSON.parse(r.params_json), cursor: r.cursor },
    ]);

  const conflicts = store
    .read<{ account_gid: string; key: string | null }>(
      "SELECT account_gid, key FROM account_conflicts ORDER BY seq",
    )
    .map((c) => `${n(c.account_gid)} ${c.key}`);

  return {
    accounts: rec(accounts),
    accountConflicts: conflicts,
    transactions: rec(transactions),
    watchlist: rec(watchlist),
    overrides: rec(overrides),
    valuations: rec(valuations),
    signals: rec(signals),
    proposals: rec(proposals),
    bindings: rec(bindings),
  };
}

/** The reference view with member-like lists sorted (their order is not part of the semantics). */
export function normalize(v: RefView): RefView {
  const sortMembers = <T extends { members: string[] }>(r: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(r).map(([k, x]) => [k, { ...x, members: [...x.members].sort() }]),
    );
  return {
    ...v,
    accounts: sortMembers(v.accounts),
    transactions: sortMembers(v.transactions),
    watchlist: sortMembers(v.watchlist),
    signals: Object.fromEntries(
      Object.entries(v.signals).map(([k, s]) => [
        k,
        { ...s, aliases: [...s.aliases].sort(), decisions: [...s.decisions].sort() },
      ]),
    ),
  };
}
