// The deriver engine (S24 4.1): dirty partitions per apply path (append, partition re-fold, full
// re-fold), `deriveAll` on rebuild, touched tables, contributions, registry rules. A toy module over
// `categoryRule.set` keeps the test independent of the budget derivers. Synthetic data only.
import { describe, expect, it } from "vitest";
import { coreModule } from "../core/index.js";
import { detGid } from "../gid.js";
import { ModuleRegistry, type StoreModule } from "../registry.js";
import { viewHash } from "../snapshot.js";
import { EventFactory, openTestStore, TEST_SALT } from "../testing/store.js";
import { CONTRIBUTIONS, type Deriver, type DirtyPartitions, type Materializer } from "./types.js";

const rulesMat: Materializer = {
  id: "toy.rules",
  version: 1,
  tables: [
    {
      name: "toy_rules",
      columns: [
        { name: "merchant_key", type: "TEXT", notNull: true },
        { name: "category", type: "TEXT", notNull: true },
        { name: "len", type: "INTEGER" },
      ],
    },
  ],
  handles: ["categoryRule.set"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write("toy_rules", "DELETE FROM toy_rules WHERE gid = ?", g);
  },
  apply(e, ctx) {
    ctx.sql.write(
      "toy_rules",
      `INSERT INTO toy_rules (id, gid, merchant_key, category) VALUES (?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET category = excluded.category`,
      ctx.id(e.gid),
      e.gid,
      String(e.data.merchantKey),
      String(e.data.category),
    );
  },
};

function toyModule(calls: DirtyPartitions[], all: { n: number }, patterns = false): StoreModule {
  const deriver: Deriver = {
    id: "toy.len",
    version: 1,
    writes: [{ table: "toy_rules", columns: ["len"] }],
    inputs: patterns ? ["toy.rules", CONTRIBUTIONS] : ["toy.rules"],
    derive(dirty, ctx) {
      calls.push(dirty);
      const p = dirty.get("toy.rules");
      if (p === undefined || p === "all") return;
      for (const g of p) {
        ctx.sql.write("toy_rules", "UPDATE toy_rules SET len = length(category) WHERE gid = ?", g);
      }
    },
    deriveAll(ctx) {
      all.n += 1;
      ctx.sql.write(
        "toy_rules",
        "UPDATE toy_rules SET len = length(category) WHERE len IS NOT length(category)",
      );
    },
  };
  return {
    id: "toy",
    materializers: [rulesMat],
    derivers: [deriver],
    ...(patterns
      ? {
          contributions: {
            reads: ["toy_rules"],
            paymentPatterns: () => [{ category: "loans", counterpartyIban: null, text: "RATA" }],
          },
        }
      : {}),
  };
}

const ruleGid = (key: string) => detGid(TEST_SALT, "category_rules", [key]);
const rule = (f: EventFactory, key: string, category: string, wall?: number) =>
  f.make(
    "categoryRule.set",
    ruleGid(key),
    { merchantKey: key, category, source: "manual", locked: false },
    wall === undefined ? {} : { wall },
  );

function lens(store: ReturnType<typeof openTestStore>) {
  return store.read<{ merchant_key: string; len: number | null }>(
    "SELECT merchant_key, len FROM toy_rules ORDER BY merchant_key",
  );
}

describe("derivers", () => {
  it("run on the partitions an append folded, and report the derived table as touched", () => {
    const calls: DirtyPartitions[] = [];
    const all = { n: 0 };
    const store = openTestStore({ modules: [coreModule, toyModule(calls, all)] });
    const f = new EventFactory();
    const r = store.applyEnvelopes([rule(f, "SHOP", "groceries", 10), rule(f, "FUEL", "fuel", 11)]);
    expect(r.touchedTables.has("toy_rules")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.get("toy.rules")).toEqual(new Set([ruleGid("SHOP"), ruleGid("FUEL")]));
    expect(lens(store)).toEqual([
      { merchant_key: "FUEL", len: 4 },
      { merchant_key: "SHOP", len: 9 },
    ]);
    expect(all.n).toBe(0);
  });

  it("re-derive the closure of a partition re-fold; the derived oracle changes nothing", () => {
    const calls: DirtyPartitions[] = [];
    const store = openTestStore({ modules: [coreModule, toyModule(calls, { n: 0 })] });
    const f = new EventFactory();
    store.applyEnvelopes([rule(f, "SHOP", "groceries", 20), rule(f, "FUEL", "fuel", 21)]);
    // An older edit of SHOP: SHOP is re-folded (its later edit still wins), FUEL is untouched.
    store.applyEnvelopes([rule(f, "SHOP", "x", 5)]);
    expect(calls.at(-1)?.get("toy.rules")).toEqual(new Set([ruleGid("SHOP")]));
    expect(lens(store)).toEqual([
      { merchant_key: "FUEL", len: 4 },
      { merchant_key: "SHOP", len: 9 },
    ]);
    const before = viewHash(store).hash;
    expect(store.rederive().touchedTables.size).toBe(0);
    expect(viewHash(store).hash).toBe(before);
  });

  it("deriveAll after a rebuild and on a touched contribution table", () => {
    const calls: DirtyPartitions[] = [];
    const all = { n: 0 };
    const store = openTestStore({ modules: [coreModule, toyModule(calls, all, true)] });
    const f = new EventFactory();
    store.applyEnvelopes([rule(f, "SHOP", "groceries")]);
    expect(all.n).toBe(1); // toy_rules is a contribution read: CONTRIBUTIONS is "all"
    const hash = viewHash(store).hash;
    store.rebuild();
    expect(all.n).toBe(2);
    expect(viewHash(store).hash).toBe(hash);
  });

  it("registry rules: inputs, one writer per derived column, owned tables", () => {
    const base = toyModule([], { n: 0 });
    const d = base.derivers?.[0] as Deriver;
    expect(
      () => new ModuleRegistry([coreModule, { ...base, derivers: [d, { ...d, id: "toy.b" }] }]),
    ).toThrow(/derived twice/);
    expect(
      () =>
        new ModuleRegistry([coreModule, { ...base, derivers: [{ ...d, inputs: ["toy.nope"] }] }]),
    ).toThrow(/unknown input/);
    expect(
      () => new ModuleRegistry([coreModule, { ...base, derivers: [{ ...d, inputs: [] }] }]),
    ).toThrow(/no inputs/);
    const fp = (m: StoreModule) => new ModuleRegistry([coreModule, m]).fingerprint();
    expect(fp(base)).not.toBe(fp({ ...base, derivers: [{ ...d, version: 2 }] }));
  });
});
