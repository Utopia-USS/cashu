// Core bridges (S31a spec 4.4; events.md 8.2): profiles, modules, accounts and balances. Each rule
// maps a synthetic Python change to catalog events through the planner (parseEvent + DET
// self-check). Synthetic rows only.
import { ibanKey } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { isValidIban } from "../../events/v1/identity.js";
import type { GidResolver } from "../../genesis/ids.js";
import { GenesisCounters } from "../../genesis/report.js";
import { readPythonSource, scopeProfiles } from "../../genesis/source.js";
import { NO_FILES } from "../../genesis/testing/phase1.js";
import { PythonRows } from "../../genesis/testing/pythonRows.js";
import { pythonDb } from "../../genesis/testing/pythonSchema.js";
import { plan } from "../plan.js";
import type { CurrentRows } from "../resolve.js";
import { DET, idsOf, outboxRow, T0, T1, testPorts, VAULT, vaultInput } from "../testing/rows.js";

const ACCOUNT_GID = "01JQ0000000000000000000010";
/** A checksum-valid synthetic IBAN (the textbook example number). */
const IBAN = "PL61109010140000071219812874";

const ids = idsOf({
  "profiles|1": VAULT,
  "profile_modules|1|budget": DET("profile_modules", ["budget"]),
  "accounts|3": ACCOUNT_GID,
  "balances|9": DET("balances", [ACCOUNT_GID, "2026-03-01", "csv"]),
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: Row[], current?: () => CurrentRows, syncIds: GidResolver = ids) {
  const ports = testPorts();
  const r = plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(syncIds, current)],
    ports,
  });
  return { r, ports };
}

function shipped(rows: Row[], current?: () => CurrentRows, syncIds: GidResolver = ids) {
  const { r, ports } = run(rows, current, syncIds);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t), ports };
}

function blocked(rows: Row[], current?: () => CurrentRows): string {
  const { r } = run(rows, current);
  return r.ok ? "ok" : r.reason;
}

/** The live Python rows (phase-1 input) of profile 1 with the given accounts. */
function live(accounts: readonly Record<string, string | number | null>[]): () => CurrentRows {
  const driver = pythonDb();
  const r = new PythonRows(driver);
  r.insert("profiles");
  for (const a of accounts) r.insert("accounts", a);
  const counters = new GenesisCounters();
  const source = readPythonSource(driver, NO_FILES, counters);
  const [scope] = scopeProfiles(source, counters);
  if (scope === undefined) throw new Error("no scope");
  const global = { instruments: source.invInstruments, aliases: source.invInstrumentAliases };
  return () => ({ scope, global });
}

const profilePost = (o: Record<string, unknown> = {}) => ({
  id: 1,
  slug: "syn",
  name: "Syn",
  base_currency: "PLN",
  mcp_privacy: "strict",
  created_at: T0,
  ...o,
});

const accountPost = (o: Record<string, unknown> = {}) => ({
  id: 3,
  bank: "mbank",
  name: "syn account",
  iban: null,
  external_id: null,
  currency: "PLN",
  type: "checking",
  active: 1,
  created_at: T0,
  removed_at: null,
  ...o,
});

const balancePost = (o: Record<string, unknown> = {}) => ({
  id: 9,
  account_id: 3,
  date: "2026-03-01",
  amount: "100.00",
  currency: "PLN",
  source: "CSV",
  created_at: T0,
  ...o,
});

describe("profiles", () => {
  it("an insert is profile.created on the vault gid", () => {
    const { events } = shipped([
      { table: "profiles", localId: "1", gid: VAULT, fields: profilePost(), post: profilePost() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.slug])).toEqual([["profile.created", VAULT, "syn"]]);
  });

  it("a rename is profile.renamed; a privacy change is settingsChanged with that field only", () => {
    const { events } = shipped([
      {
        table: "profiles",
        localId: "1",
        op: "update",
        gid: VAULT,
        fields: { name: "Syn 2", mcp_privacy: "amounts" },
        prev: { name: "Syn", mcp_privacy: "strict" },
        post: profilePost({ name: "Syn 2", mcp_privacy: "amounts" }),
      },
    ]);
    expect(events.map((e) => e.t)).toEqual(["profile.renamed", "profile.settingsChanged"]);
    expect(events[0]?.d).toMatchObject({ name: "Syn 2" });
    expect(Object.keys(events[1]?.d ?? {}).sort()).toEqual(["mcpPrivacy", "stamps"]);
  });

  it("refuses a slug change", () => {
    expect(
      blocked([
        {
          table: "profiles",
          localId: "1",
          op: "update",
          gid: VAULT,
          fields: { slug: "other" },
          prev: { slug: "syn" },
          post: profilePost({ slug: "other" }),
        },
      ]),
    ).toBe("immutable:profiles:slug");
  });
});

describe("profile modules", () => {
  const modulePost = (enabled: number) => ({ module_id: "budget", enabled, enabled_at: T0 });

  it("an insert without a Python gid is module.enabled on DET(module)", () => {
    const { events, plan: p } = shipped([
      { table: "profile_modules", localId: "1|budget", fields: modulePost(1), post: modulePost(1) },
    ]);
    const gid = DET("profile_modules", ["budget"]);
    expect(events.map((e) => [e.t, e.g])).toEqual([["module.enabled", gid]]);
    expect(p.batches[0]?.gids).toEqual([{ table: "profile_modules", localId: "1|budget", gid }]);
  });

  it("enabled 1 -> 0 is module.disabled, 0 -> 1 module.enabled", () => {
    const toggle = (from: number, to: number) =>
      shipped([
        {
          table: "profile_modules",
          localId: "1|budget",
          op: "update",
          fields: { enabled: to },
          prev: { enabled: from },
          post: modulePost(to),
        },
      ]).types;
    expect(toggle(1, 0)).toEqual(["module.disabled"]);
    expect(toggle(0, 1)).toEqual(["module.enabled"]);
  });

  it("has no delete event", () => {
    expect(
      blocked([
        { table: "profile_modules", localId: "1|budget", op: "delete", fields: modulePost(1) },
      ]),
    ).toBe("no-delete-event:profile_modules");
  });
});

describe("accounts", () => {
  it("the synthetic IBAN is checksum-valid", () => {
    expect(isValidIban(IBAN)).toBe(true);
  });

  it("an insert with an IBAN opens DET(iban) and claims its key", () => {
    const post = accountPost({ iban: IBAN });
    const { events, plan: p } = shipped(
      [{ table: "accounts", localId: "3", fields: post, post }],
      live([post]),
    );
    const gid = DET("accounts", ["iban", ibanKey(IBAN)]);
    expect(events.map((e) => [e.t, e.g, e.d.keys])).toEqual([
      ["account.opened", gid, [`iban:${ibanKey(IBAN)}`]],
    ]);
    expect(p.batches[0]?.gids).toEqual([{ table: "accounts", localId: "3", gid }]);
  });

  it("an insert without a natural key gets a minted ULID, not a genesis gid", () => {
    const post = accountPost({ bank: "manual", external_id: "manual:car" });
    const { events, ports } = shipped(
      [{ table: "accounts", localId: "3", fields: post, post }],
      live([post]),
    );
    expect(events.map((e) => [e.t, e.g, e.d.keys])).toEqual([
      ["account.opened", ports.minted[0], []],
    ]);
  });

  it("an IBAN fill is account.identified on the existing gid", () => {
    const post = accountPost({ iban: IBAN });
    const { events } = shipped(
      [
        {
          table: "accounts",
          localId: "3",
          op: "update",
          fields: { iban: IBAN },
          prev: { iban: null },
          post,
        },
      ],
      live([post]),
    );
    expect(events.map((e) => [e.t, e.g, e.d.iban, e.d.keys])).toEqual([
      ["account.identified", ACCOUNT_GID, IBAN, [`iban:${ibanKey(IBAN)}`]],
    ]);
    expect("externalId" in (events[0]?.d ?? {})).toBe(false);
  });

  it("rename, type and removal; restore", () => {
    const removed = accountPost({ name: "n2", type: "savings", removed_at: T1 });
    const a = shipped(
      [
        {
          table: "accounts",
          localId: "3",
          op: "update",
          fields: { name: "n2", type: "savings", removed_at: T1 },
          prev: { name: "syn account", type: "checking", removed_at: null },
          post: removed,
        },
      ],
      live([removed]),
    );
    expect(a.events.map((e) => [e.t, e.g])).toEqual([
      ["account.renamed", ACCOUNT_GID],
      ["account.typeSet", ACCOUNT_GID],
      ["account.removed", ACCOUNT_GID],
    ]);
    expect(a.events[2]?.d).toMatchObject({ stamps: { removed_at: "2026-03-02T11:30:00.250000Z" } });
    const restore = shipped(
      [
        {
          table: "accounts",
          localId: "3",
          op: "update",
          fields: { removed_at: null },
          prev: { removed_at: T1 },
          post: accountPost(),
        },
      ],
      live([accountPost()]),
    );
    expect(restore.types).toEqual(["account.restored"]);
  });

  it("blocks a bank change, an identifier overwrite and a fill without an identity key", () => {
    expect(
      blocked(
        [
          {
            table: "accounts",
            localId: "3",
            op: "update",
            fields: { bank: "pekao" },
            prev: { bank: "mbank" },
            post: accountPost({ bank: "pekao" }),
          },
        ],
        live([accountPost({ bank: "pekao" })]),
      ),
    ).toBe("immutable:accounts:bank");
    const other = accountPost({ iban: IBAN });
    expect(
      blocked(
        [
          {
            table: "accounts",
            localId: "3",
            op: "update",
            fields: { iban: IBAN },
            prev: { iban: "PL00" },
            post: other,
          },
        ],
        live([other]),
      ),
    ).toBe("immutable:accounts:iban");
    const invalid = accountPost({ iban: "12345" });
    expect(
      blocked(
        [
          {
            table: "accounts",
            localId: "3",
            op: "update",
            fields: { iban: "12345" },
            prev: { iban: null },
            post: invalid,
          },
        ],
        live([invalid]),
      ),
    ).toBe("no-identity-key:accounts");
  });
});

describe("balances", () => {
  it("an insert is balance.recorded on DET(account, date, source)", () => {
    const { events } = shipped([
      { table: "balances", localId: "9", fields: balancePost(), post: balancePost() },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.account, e.d.source, e.d.amount])).toEqual([
      [
        "balance.recorded",
        DET("balances", [ACCOUNT_GID, "2026-03-01", "csv"]),
        ACCOUNT_GID,
        "csv",
        "100.00",
      ],
    ]);
  });

  it("upsert_balance rewriting amount and created_at is the whole balance.recorded", () => {
    const post = balancePost({ amount: "120.50", created_at: T1 });
    const { events, plan: p } = shipped([
      {
        table: "balances",
        localId: "9",
        op: "update",
        fields: { amount: "120.50", created_at: T1 },
        prev: { amount: "100.00", created_at: T0 },
        post,
      },
    ]);
    expect(events.map((e) => [e.t, e.d.amount, e.d.currency])).toEqual([
      ["balance.recorded", "120.50", "PLN"],
    ]);
    expect(events[0]?.d).toMatchObject({ stamps: { created_at: "2026-03-02T11:30:00.250000Z" } });
    expect(p.batches[0]?.carries[0]).toEqual([
      { table: "balances", localId: "9", columns: ["amount", "created_at"] },
    ]);
  });

  it("blocks a change of a DET part and a delete", () => {
    expect(
      blocked([
        {
          table: "balances",
          localId: "9",
          op: "update",
          fields: { date: "2026-03-02" },
          prev: { date: "2026-03-01" },
          post: balancePost({ date: "2026-03-02" }),
        },
      ]),
    ).toBe("immutable:balances:date");
    expect(
      blocked([{ table: "balances", localId: "9", op: "delete", fields: balancePost() }]),
    ).toBe("no-delete-event:balances");
  });
});
