/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACC,
  DEVICE,
  INST,
  ULID_A,
  ULID_B,
  VALID_SAMPLES,
  VAULT,
} from "../../testing/event-fixtures.js";
import {
  CURRENT_VERSION,
  type EventType,
  META,
  PAYLOADS,
  parseEvent,
  RESERVED_PREFIXES,
} from "./catalog.js";
import { envelopeSchema, fromWire, toWire } from "./envelope.js";

const HLC = `0mvwcmtc0-0000-${DEVICE}`;

function envelope(
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    eid: ULID_A,
    vault: VAULT,
    device: DEVICE,
    hlc: HLC,
    at: "2026-10-31T12:00:00.000Z",
    type,
    v: 1,
    gid: ULID_B,
    data,
    ...extra,
  };
}

const TYPES = Object.keys(PAYLOADS) as EventType[];

describe("catalog shape", () => {
  it("has metadata and version 1 for every type, and nothing else", () => {
    expect(Object.keys(META).sort()).toEqual([...TYPES].sort());
    for (const t of TYPES) expect(CURRENT_VERSION[t]).toBe(1);
  });

  it("uses <entity>.<verb> names outside the reserved prefixes", () => {
    for (const t of TYPES) {
      expect(t).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
      expect(RESERVED_PREFIXES.some((p) => t.startsWith(p))).toBe(false);
    }
  });

  it("matches the per-table catalog of events.md (both directions)", () => {
    const spec = readFileSync(new URL("../../../spec/events.md", import.meta.url), "utf8");
    const section = spec.slice(spec.indexOf("### 8.1"), spec.indexOf("### 8.2"));
    const inSpec = new Set(
      [...section.matchAll(/`([a-z][a-zA-Z]*\.[a-z][a-zA-Z]*)`/g)]
        .map((m) => m[1] ?? "")
        .filter((t) => !t.endsWith(".py") && !t.endsWith(".md")),
    );
    expect([...inSpec].sort()).toEqual([...TYPES].sort());
  });

  it("leader-only types are the documented ones", () => {
    const leader = TYPES.filter((t) => META[t].emitter === "leader").sort();
    expect(leader).toEqual(
      [
        "alert.evaluated",
        "connectorBinding.cursorAdvanced",
        "ruleRun.finished",
        "signal.woken",
      ].sort(),
    );
  });
});

describe("payload schemas: valid samples", () => {
  it.each(TYPES)("%s accepts its synthetic sample", (type) => {
    const result = PAYLOADS[type].safeParse(VALID_SAMPLES[type]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(TYPES)("%s parses as a known event inside an envelope", (type) => {
    const gid = META[type].gid === "VAULT" ? { gid: VAULT } : {};
    const r = parseEvent(envelope(type, VALID_SAMPLES[type], gid));
    expect(r.status).toBe("known");
  });
});

describe("S25 catalog deltas (optional fields, absent keeps the v1 meaning)", () => {
  // Field order in these shapes is free: the log copy takes positions from the append-only field
  // table (engine/field-table.ts, events.md 4.5), whose guard covers every new field.

  it("accepts the refresh fields, run / payloadSet on close, payloadUnset, rearm", () => {
    const ok = (t: EventType, d: Record<string, unknown>) =>
      expect(PAYLOADS[t].safeParse(d).success).toBe(true);
    ok("signal.refreshed", {
      ...VALID_SAMPLES["signal.refreshed"],
      ruleId: "research:2026-w44",
      kind: "research",
      polarity: "positive",
      instrument: null,
      account: ACC,
    });
    ok("signal.escalated", { ...VALID_SAMPLES["signal.escalated"], instrument: INST });
    ok("signal.closed", { status: "resolved", reason: "x", run: null, payloadSet: { a: 1 } });
    ok("signal.reopened", { reason: "note_restored", payloadUnset: ["closed_reason"] });
    ok("alert.restored", { rearm: true });
    ok("alert.restored", {});
  });

  it("keeps unknown fields of the extended shapes (loose objects)", () => {
    const r = PAYLOADS["signal.closed"].safeParse({ status: "resolved", reason: "x", future: 1 });
    expect(r.success && (r.data as Record<string, unknown>).future).toBe(1);
  });
});

describe("alert tag: lower-case letters, digits, hyphens and single spaces, at most 24 chars", () => {
  const tagOk = (tag: unknown) => PAYLOADS["alert.updated"].safeParse({ tag }).success;
  it.each(["cena", "średnia krocząca", "rsi-14", "wybicie 2", "-", "a".repeat(24), "ąę"])(
    "accepts %j",
    (tag) => expect(tagOk(tag)).toBe(true),
  );
  it.each(["", "Cena", "cena!", " cena", "cena ", "dwie  spacje", "a".repeat(25), "tab\tx", "١٢"])(
    "rejects %j",
    (tag) => expect(tagOk(tag)).toBe(false),
  );
  it("null clears; the create field is optional", () => {
    expect(tagOk(null)).toBe(true);
    const create = VALID_SAMPLES["alert.created"];
    expect(PAYLOADS["alert.created"].safeParse({ ...create, tag: "cena" }).success).toBe(true);
    expect(PAYLOADS["alert.created"].safeParse({ ...create, tag: "Cena" }).success).toBe(false);
  });
});

describe("payload schemas: invalid samples", () => {
  const bad: Array<[EventType, Record<string, unknown>, string]> = [
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], amount: 12.5 },
      "money as a number",
    ],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], amount: "1E+1" },
      "exponent decimal",
    ],
    ["balance.recorded", { ...VALID_SAMPLES["balance.recorded"], amount: "007" }, "leading zeros"],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], date: "2026-02-30" },
      "impossible date",
    ],
    ["balance.recorded", { ...VALID_SAMPLES["balance.recorded"], account: 12 }, "local integer id"],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], account: "12" },
      "integer id as text",
    ],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], account: ACC.toUpperCase() },
      "upper-case uuid",
    ],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], source: "OPEN_BANKING" },
      "enum name",
    ],
    ["txn.imported", { ...VALID_SAMPLES["txn.imported"], dedupHash: "abc" }, "short dedup hash"],
    ["txn.categorySet", { category: "groceries", source: "keyword" }, "rule-engine source"],
    [
      "txn.cashExpenseAdded",
      { ...VALID_SAMPLES["txn.cashExpenseAdded"], amount: "20" },
      "positive",
    ],
    ["invTxn.imported", { ...VALID_SAMPLES["invTxn.imported"], createdAt: undefined }, "no rank"],
    ["invTxn.imported", { ...VALID_SAMPLES["invTxn.imported"], type: "short" }, "unknown txn type"],
    [
      "invTxn.imported",
      { ...VALID_SAMPLES["invTxn.imported"], createdAt: "2026-02-03 10:00:00" },
      "naive timestamp",
    ],
    [
      "signal.opened",
      { ...VALID_SAMPLES["signal.opened"], dedupKey: "drawdown|i:12" },
      "int in key",
    ],
    ["signal.woken", {}, "wake without the snooze it ends (M7)"],
    ["signal.reopened", { reason: "manual" }, "unknown reopen reason"],
    [
      "signal.refreshed",
      { ...VALID_SAMPLES["signal.refreshed"], instrument: "12" },
      "refresh to a local instrument id",
    ],
    [
      "signal.closed",
      { ...VALID_SAMPLES["signal.closed"], payloadSet: ["closed_by"] },
      "payloadSet as a list",
    ],
    ["signal.reopened", { reason: "note_restored", payloadUnset: "closed_by" }, "unset as text"],
    ["alert.restored", { rearm: false }, "rearm must be true when present"],
    ["note.candidateUpdated", { details: null }, "candidate update without the instrument"],
    ["note.signalLinked", { signal: null }, "link to no signal"],
    [
      "invTxn.imported",
      { ...VALID_SAMPLES["invTxn.imported"], source: "manual" },
      "manual entry with a content hash (m1)",
    ],
    ["txn.cashExpenseAdded", { ...VALID_SAMPLES["txn.cashExpenseAdded"], amount: "-0.00" }, "zero"],
    ["account.opened", { ...VALID_SAMPLES["account.opened"], keys: ["iban:pl00"] }, "bad key"],
    ["account.identified", { iban: "XX00", keys: [] }, "identify without a key"],
    ["loan.paymentMatchingSet", { paymentIban: null, paymentText: "rata" }, "no account (m7)"],
    [
      "balance.recorded",
      { ...VALID_SAMPLES["balance.recorded"], account: "98ff7ab1-8526-5a5c-815d-422cd15b31c2" },
      "unkeyed UUIDv5 gid",
    ],
    [
      "profile.created",
      { ...VALID_SAMPLES["profile.created"], stamps: { createdAt: "x" } },
      "stamps",
    ],
    ["signal.opened", { ...VALID_SAMPLES["signal.opened"], ruleId: "alert:4" }, "alert int id"],
    ["signal.opened", { ...VALID_SAMPLES["signal.opened"], dedupKey: "alert:4" }, "alert int key"],
    ["alert.statusSet", { status: "triggered", snoozedUntil: null }, "runtime status by owner"],
    ["alert.statusSet", { status: "snoozed", snoozedUntil: null }, "snooze without until"],
    [
      "alert.statusSet",
      { status: "muted", snoozedUntil: "2026-11-07T12:00:00Z" },
      "mute with until",
    ],
    ["alert.updated", {}, "empty patch"],
    ["instrumentOverride.set", { instrument: INST }, "patch with only the subject"],
    ["instrumentOverride.set", { tags: ["x"] }, "patch without the subject"],
    ["instrument.merged", { source: INST, target: INST, reason: "owner" }, "self merge"],
    [
      "decision.recorded",
      { ...VALID_SAMPLES["decision.recorded"], signals: [INST, INST] },
      "dup link",
    ],
    ["plannedDeposit.created", { ...VALID_SAMPLES["plannedDeposit.created"], amount: "0" }, "zero"],
    [
      "proposal.created",
      { ...VALID_SAMPLES["proposal.created"], payload: { account_id: 3, staged: "imports/x.csv" } },
      "local id and device path",
    ],
    ["thesis.updated", { reviewed: false }, "reviewed must be true when present"],
    [
      "profile.created",
      { ...VALID_SAMPLES["profile.created"], mcpPrivacy: "full" },
      "privacy level",
    ],
    [
      "topicThesis.ownerSaved",
      { segment: "gold", thesis: "x".repeat(601), invalidation: null },
      "thesis too long",
    ],
  ];

  it.each(bad)("%s rejects: %s", (type, data) => {
    expect(PAYLOADS[type].safeParse(data).success).toBe(false);
  });
});

describe("parseEvent: broken envelopes (store-level parking is in upgrade.test.ts)", () => {
  it("rejects a broken envelope", () => {
    expect(parseEvent(null).status).toBe("rejected");
    expect(parseEvent(envelope("alert.deleted", {}, { eid: "not-a-ulid" })).status).toBe(
      "rejected",
    );
    expect(parseEvent(envelope("alert.deleted", {}, { v: 0 })).status).toBe("rejected");
    expect(parseEvent(envelope("alert.deleted", {}, { gid: 42 })).status).toBe("rejected");
    expect(parseEvent(envelope("Alert.Deleted", {})).status).toBe("rejected");
    expect(parseEvent(envelope("alert.deleted", {}, { origin: "python" })).status).toBe("rejected");
  });
});

describe("v1.1 acceptance of real shapes", () => {
  it("accepts the rule-run trigger `app` and other open informational labels (M4)", () => {
    const run = { ...VALID_SAMPLES["ruleRun.finished"], trigger: "app" };
    expect(PAYLOADS["ruleRun.finished"].safeParse(run).success).toBe(true);
    const alert = { ...VALID_SAMPLES["alert.created"], createdBy: "worker" };
    expect(PAYLOADS["alert.created"].safeParse(alert).success).toBe(true);
  });

  it("accepts genesis stamps on any payload (M3)", () => {
    const thesis = {
      ...VALID_SAMPLES["thesis.created"],
      stamps: {
        created_at: "2025-01-02T03:04:05.123456Z",
        core_changed_at: "2025-02-01T00:00:00Z",
        exit_plan_changed_at: null,
      },
    };
    expect(PAYLOADS["thesis.created"].safeParse(thesis).success).toBe(true);
  });

  it("keeps absent vs null for topic invalidation and market-view sources (M9)", () => {
    const draft = { segment: "gold", thesis: "Szkic" };
    expect(PAYLOADS["topicThesis.draftProposed"].safeParse(draft).success).toBe(true);
    const view = { segment: "gold", assessment: "a", outlook: null, by: "owner" };
    expect(PAYLOADS["topicThesis.marketViewSet"].safeParse(view).success).toBe(true);
  });

  it("accepts a research source without a title, never one without a url", () => {
    const sources = [{ title: null, url: "https://example.com/a", publisher: "Example" }];
    const note = { ...VALID_SAMPLES["note.added"], sources };
    expect(PAYLOADS["note.added"].safeParse(note).success).toBe(true);
    const missingUrl = { ...note, sources: [{ title: "t" }] };
    expect(PAYLOADS["note.added"].safeParse(missingUrl).success).toBe(false);
  });

  it("parks instrument.merged whose gid is not the source (m11)", () => {
    const data = VALID_SAMPLES["instrument.merged"];
    expect(parseEvent(envelope("instrument.merged", data, { gid: ULID_B })).status).toBe("known");
    const r = parseEvent(envelope("instrument.merged", data, { gid: INST }));
    expect(r.status === "parked" && r.reason === "invalid-payload").toBe(true);
  });

  it("accepts a manual inv txn whose dedupHash names its own ULID or genesis gid (S26-F1)", () => {
    const genesisGid = "c1e52d4d-d9a5-84e6-8d7a-c21b36691202";
    const manual = { ...VALID_SAMPLES["invTxn.imported"], source: "manual" };
    for (const gid of [ULID_B, genesisGid]) {
      const data = { ...manual, dedupHash: `manual:${gid}` };
      expect(parseEvent(envelope("invTxn.imported", data, { gid })).status).toBe("known");
    }
  });

  it("parks a manual inv txn whose dedupHash names another gid (S26-F1)", () => {
    const data = {
      ...VALID_SAMPLES["invTxn.imported"],
      source: "manual",
      dedupHash: `manual:${ULID_A}`,
    };
    const r = parseEvent(envelope("invTxn.imported", data, { gid: ULID_B }));
    expect(r.status === "parked" && r.reason === "invalid-payload").toBe(true);
  });
});

describe("wire form (own-log carrier)", () => {
  it("round-trips through the spike's {t, v, h, d} keys plus i, g, a, c, o", () => {
    const env = envelope("alert.deleted", {}, { cause: ULID_B, origin: "genesis", sig: "x" });
    const wire = toWire(envelopeSchema.parse(env));
    expect(wire).toMatchObject({ t: "alert.deleted", v: 1, h: HLC, d: {}, i: ULID_A, c: ULID_B });
    expect(wire).not.toHaveProperty("vault");
    expect(wire).not.toHaveProperty("device");
    const back = fromWire(wire, { vault: VAULT, device: DEVICE });
    expect(back).toEqual(env);
    expect(parseEvent(back).status).toBe("known");
  });

  it("rejects a frame event whose HLC belongs to another device than its segment", () => {
    const wire = toWire(envelopeSchema.parse(envelope("alert.deleted", {})));
    const back = fromWire(wire, { vault: VAULT, device: "a0000000000000000000000000000000" });
    expect(parseEvent(back).status).toBe("rejected");
  });
});

describe("envelope", () => {
  it("accepts the documented example shape", () => {
    const r = envelopeSchema.safeParse(
      envelope("alert.statusSet", { status: "muted", snoozedUntil: null }, { cause: ULID_B }),
    );
    expect(r.success).toBe(true);
  });

  it("refuses an origin other than genesis", () => {
    for (const origin of ["bridge", "native", ""])
      expect(envelopeSchema.safeParse(envelope("alert.deleted", {}, { origin })).success).toBe(
        false,
      );
    expect(
      envelopeSchema.safeParse(envelope("alert.deleted", {}, { origin: "genesis" })).success,
    ).toBe(true);
  });

  it("requires the HLC device suffix to equal the device", () => {
    const r = envelopeSchema.safeParse(
      envelope("alert.deleted", {}, { hlc: "0mvwcmtc0-0000-a0000000000000000000000000000000" }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts genesis microsecond timestamps and rejects local time", () => {
    expect(
      envelopeSchema.safeParse(envelope("alert.deleted", {}, { at: "2025-03-01T08:15:30.123456Z" }))
        .success,
    ).toBe(true);
    expect(
      envelopeSchema.safeParse(envelope("alert.deleted", {}, { at: "2025-03-01T08:15:30+01:00" }))
        .success,
    ).toBe(false);
  });

  it("rejects a vault id that is not 32 lower-case hex (a ULID, upper case)", () => {
    for (const vault of [ULID_A, VAULT.toUpperCase(), VAULT.slice(1)]) {
      expect(envelopeSchema.safeParse(envelope("alert.deleted", {}, { vault })).success).toBe(
        false,
      );
    }
  });

  it("rejects a 16-char or all-zero device id", () => {
    for (const device of ["k3v9q2m8x1c7b4n6", "0".repeat(32)]) {
      const r = envelopeSchema.safeParse(
        envelope("alert.deleted", {}, { device, hlc: `0mvwcmtc0-0000-${device}` }),
      );
      expect(r.success).toBe(false);
    }
  });

  it("uses the vault id as the gid of profile events and of nothing else", () => {
    const sample = VALID_SAMPLES["profile.renamed"];
    expect(parseEvent(envelope("profile.renamed", sample, { gid: VAULT })).status).toBe("known");
    expect(parseEvent(envelope("profile.renamed", sample, { gid: ULID_B })).status).toBe("parked");
    expect(parseEvent(envelope("alert.deleted", {}, { gid: VAULT })).status).toBe("parked");
  });
});
