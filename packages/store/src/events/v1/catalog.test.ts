/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CURRENT_VERSION,
  type EventType,
  META,
  PAYLOADS,
  parseEvent,
  RESERVED_PREFIXES,
} from "./catalog.js";
import { envelopeSchema, fromWire, toWire } from "./envelope.js";
import { ACC, DEVICE, INST, ULID_A, ULID_B, VALID_SAMPLES, VAULT } from "./test-fixtures.js";

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
    const r = parseEvent(envelope(type, VALID_SAMPLES[type]));
    expect(r.status).toBe("known");
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

describe("parseEvent: forward compatibility (events.md section 7)", () => {
  it("parks an unknown type without dropping it", () => {
    const r = parseEvent(envelope("budget.goalSet", { amount: "100" }));
    expect(r.status).toBe("parked");
    if (r.status === "parked") {
      expect(r.reason).toBe("unknown-type");
      expect(r.envelope.data).toEqual({ amount: "100" });
    }
  });

  it("parks a newer version of a known type", () => {
    const r = parseEvent(envelope("alert.deleted", {}, { v: 2 }));
    expect(r.status === "parked" && r.reason === "newer-version").toBe(true);
  });

  it("parks a payload that fails this reader's schema (e.g. a new enum value)", () => {
    const data = { ...VALID_SAMPLES["alert.created"], kind: "earnings_date" };
    const r = parseEvent(envelope("alert.created", data));
    expect(r.status === "parked" && r.reason === "invalid-payload").toBe(true);
  });

  it("keeps unknown payload and envelope fields", () => {
    const data = { ...VALID_SAMPLES["watchlist.added"], priority: 3 };
    const r = parseEvent(envelope("watchlist.added", data, { sig: "future-signature" }));
    expect(r.status).toBe("known");
    if (r.status === "known") {
      expect((r.event.data as Record<string, unknown>).priority).toBe(3);
      expect((r.event as Record<string, unknown>).sig).toBe("future-signature");
    }
  });

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

  it("parks instrument.merged whose gid is not the source (m11)", () => {
    const data = VALID_SAMPLES["instrument.merged"];
    expect(parseEvent(envelope("instrument.merged", data, { gid: ULID_B })).status).toBe("known");
    const r = parseEvent(envelope("instrument.merged", data, { gid: INST }));
    expect(r.status === "parked" && r.reason === "invalid-payload").toBe(true);
  });
});

describe("wire form (own-log carrier)", () => {
  it("round-trips through the spike's {t, v, h, d} keys plus i, g, a, c, o", () => {
    const env = envelope("alert.deleted", {}, { cause: ULID_B, origin: "bridge", sig: "x" });
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
    const back = fromWire(wire, { vault: VAULT, device: "a000000000000000" });
    expect(parseEvent(back).status).toBe("rejected");
  });
});

describe("envelope", () => {
  it("accepts the documented example shape", () => {
    const r = envelopeSchema.safeParse(
      envelope(
        "alert.statusSet",
        { status: "muted", snoozedUntil: null },
        {
          cause: ULID_B,
          origin: "bridge",
        },
      ),
    );
    expect(r.success).toBe(true);
  });

  it("requires the HLC device suffix to equal the device", () => {
    const r = envelopeSchema.safeParse(
      envelope("alert.deleted", {}, { hlc: "0mvwcmtc0-0000-a000000000000000" }),
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

  it("rejects a lower-case ULID vault", () => {
    expect(
      envelopeSchema.safeParse(envelope("alert.deleted", {}, { vault: VAULT.toLowerCase() }))
        .success,
    ).toBe(false);
  });
});
