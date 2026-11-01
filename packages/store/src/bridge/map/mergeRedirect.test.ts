// An instrument merge's transaction (lead decision, S31c item 1; review F2): the explicit merge row
// ships `instrument.merged` with the gids Python recorded in its key, and the rows the raw-SQL merge
// rewrote ship only what the fold's redirect does not already do. Synthetic rows only.
import { describe, expect, it } from "vitest";
import { TABLES } from "../../genesis/tables.js";
import { plan } from "../plan.js";
import type { CurrentRows } from "../resolve.js";
import { DET, idsOf, outboxRow, T0, testPorts, vaultInput } from "../testing/rows.js";

const SRC = DET("inv_instruments", ["isin:XS0000000001"]);
const TGT = DET("inv_instruments", ["isin:XS0000000002"]);
const WATCH_T = DET("watchlist_items", [TGT]);
const SIGNAL = "01JQ0000000000000000000002";

// Python dropped the source's mapping at emit: only the key carries it.
const ids = idsOf({
  "inv_instruments|4": TGT,
  "watchlist_items|9": WATCH_T,
  "inv_signals|7": SIGNAL,
});

const merge = outboxRow({
  table: "inv_instruments",
  localId: "3",
  op: "merge",
  profileId: null,
  fields: { source_id: 3, target_id: 4 },
  key: { source: "3", target: "4", gids: { "1": { source: SRC, target: TGT } } },
});

const watchPost = (o: Record<string, unknown>) => ({
  id: 9,
  instrument_id: 4,
  note: "syn",
  tags: [],
  source: "user",
  added_at: T0,
  removed_at: null,
  ...o,
});

describe("instrument merge transaction", () => {
  it("ships instrument.merged from the key's gids and drops what the redirect covers", () => {
    const rows = [
      merge,
      // a repoint plus a signal re-key: both redirect-only
      outboxRow({
        table: "inv_signals",
        localId: "7",
        op: "update",
        gid: SIGNAL,
        fields: { instrument_id: 4, dedup_key: "drawdown|i:4" },
        prev: { instrument_id: 3, dedup_key: "drawdown|i:3" },
      }),
      // the colliding source watchlist item Python deleted: collapsed by the fold
      outboxRow({
        table: "watchlist_items",
        localId: "8",
        op: "delete",
        fields: {
          id: 8,
          profile_id: 1,
          instrument_id: 3,
          note: "src",
          tags: [],
          source: "user",
          removed_at: null,
        },
      }),
      // the target item took the source's note: the note ships, the repoint does not
      outboxRow({
        table: "watchlist_items",
        localId: "9",
        op: "update",
        gid: WATCH_T,
        fields: { note: "syn src" },
        prev: { note: "syn" },
        post: watchPost({ note: "syn src" }),
      }),
    ];
    const r = plan({ rows, vaults: [vaultInput(ids)], ports: testPorts() });
    if (!r.ok) throw new Error(`blocked: ${r.reason}`);
    const events = r.plan.batches.flatMap((b) => b.events);
    expect(events.map((e) => [e.t, e.g])).toEqual([
      ["instrument.merged", SRC],
      ["watchlist.updated", WATCH_T],
    ]);
    expect(events[0]?.d).toMatchObject({ source: SRC, target: TGT, reason: "owner" });
    expect(r.plan.counts.noEvent).toBe(2);
  });

  it("a delete of a non-colliding table in the merge transaction still blocks", () => {
    const rows = [
      merge,
      outboxRow({
        table: "inv_signals",
        localId: "7",
        op: "delete",
        gid: SIGNAL,
        fields: { id: 7, instrument_id: 3 },
      }),
    ];
    const r = plan({ rows, vaults: [vaultInput(ids)], ports: testPorts() });
    expect(r.ok).toBe(false);
  });
});

describe("a merge in a vault that holds one side", () => {
  it("ships the target's own identity and snapshot, then folds the source into it", () => {
    const TS = "2026-03-01T10:00:00.000000Z"; // decoded form (genesis readers)
    const empty = Object.fromEntries(Object.keys(TABLES).map((k) => [k, []]));
    const target = {
      id: 4,
      name: "Syn Target",
      currency: "USD",
      assetClass: "etf",
      symbol: "TGT",
      isin: null,
      mic: null,
      region: null,
      sector: null,
      tags: [],
      needsClassification: false,
      valuationMode: "market",
      status: "active",
      createdAt: TS,
      updatedAt: TS,
    };
    const alias = (id: number, namespace: string, value: string) => ({
      id,
      instrumentId: 4,
      namespace,
      value,
      guessed: false,
      createdAt: TS,
    });
    const current = (): CurrentRows => ({
      scope: {
        ...empty,
        profile: {
          id: 1,
          slug: "syn",
          name: "Syn",
          baseCurrency: "PLN",
          mcpPrivacy: "strict",
          createdAt: T0,
        },
      } as unknown as CurrentRows["scope"],
      global: {
        instruments: [target],
        aliases: [alias(11, "yahoo", "TGT"), alias(12, "isin", "XS0000000001")],
      },
    });
    const only = outboxRow({
      table: "inv_instruments",
      localId: "3",
      op: "merge",
      profileId: null,
      fields: { source_id: 3, target_id: 4 },
      key: { source: "3", target: "4", gids: { "1": { source: SRC, target: null } } },
    });
    // the source's ISIN alias, repointed by the merge (the fold's redirect covers it)
    const moved = outboxRow({
      table: "inv_instrument_aliases",
      localId: "12",
      op: "update",
      profileId: null,
      fields: { instrument_id: 4 },
      prev: { instrument_id: 3 },
    });
    const ownGid = DET("inv_instruments", ["yahoo:TGT"]);
    const r = plan({
      rows: [only, moved],
      vaults: [
        vaultInput(
          idsOf({
            "inv_instrument_aliases|12": DET("inv_instrument_aliases", ["isin", "XS0000000001"]),
          }),
          current,
        ),
      ],
      ports: testPorts(),
    });
    if (!r.ok) throw new Error(`blocked: ${r.reason}`);
    const events = r.plan.batches.flatMap((b) => b.events);
    expect(events.map((e) => [e.t, e.g])).toEqual([
      ["instrument.created", ownGid],
      ["instrument.aliasAdded", DET("inv_instrument_aliases", ["yahoo", "TGT"])],
      ["instrument.merged", SRC],
    ]);
    expect(events[2]?.d).toMatchObject({ source: SRC, target: ownGid });
    expect(r.plan.batches[0]?.gids.map((g) => [g.table, g.localId])).toContainEqual([
      "inv_instruments",
      "4",
    ]);
  });
});
