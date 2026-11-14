/// <reference types="node" />
// The payload-derived DET parts table (gid.md 4, events.md 7.10): complete over the catalog, and
// pinned to the gid.md section 8 vectors (Python hmac, test salt 00..1f).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VALID_SAMPLES } from "../../testing/event-fixtures.js";
import { type EventType, META, PAYLOADS } from "./catalog.js";
import { type DetParts, detPartsOf, NOT_PAYLOAD_DERIVED } from "./det-parts.js";
import { detMessage, uuid8FromDigest, VAULT_SALT_BYTES } from "./namespaces.js";

const SALT = Buffer.from(Array.from({ length: VAULT_SALT_BYTES }, (_, i) => i));
const gidFrom = (p: DetParts | undefined): string => {
  if (p === undefined) throw new Error("no DET parts");
  return uuid8FromDigest(
    createHmac("sha256", SALT).update(detMessage(p.table, p.parts), "utf8").digest(),
  );
};

const TYPES = Object.keys(PAYLOADS) as EventType[];

describe("detPartsOf covers the catalog", () => {
  it("every DET type either derives its gid from its payload or is listed as not payload-derived", () => {
    for (const t of TYPES.filter((x) => META[x].gid === "DET")) {
      const derived = detPartsOf(t, VALID_SAMPLES[t]) !== undefined;
      expect(derived !== NOT_PAYLOAD_DERIVED.has(t), t).toBe(true);
    }
  });

  it("no other gid strategy is checked, except an instrument created under an alias", () => {
    for (const t of TYPES.filter((x) => META[x].gid !== "DET")) {
      expect(NOT_PAYLOAD_DERIVED.has(t), t).toBe(false);
      if (t === "instrument.created") continue;
      expect(detPartsOf(t, VALID_SAMPLES[t]), t).toBeUndefined();
    }
    const created = { ...VALID_SAMPLES["instrument.created"] };
    expect(detPartsOf("instrument.created", { ...created, creationAlias: null })).toBeUndefined();
    expect(detPartsOf("instrument.created", { ...created, creationAlias: "isin:X" })).toEqual({
      table: "inv_instruments",
      parts: ["isin:X"],
    });
  });

  it("does not check a manual investment entry (ULID or genesis gid, gid.md 4.6 / 7)", () => {
    for (const gid of ["01JC0ZA1B2C3D4E5F6G7H8J9K0", "c1e52d4d-d9a5-84e6-8d7a-c21b36691202"]) {
      const manual = { ...VALID_SAMPLES["invTxn.imported"], dedupHash: `manual:${gid}` };
      expect(detPartsOf("invTxn.imported", manual)).toBeUndefined();
    }
  });

  it("reads parts as written: unknown types and payload-free types give nothing", () => {
    expect(detPartsOf("future.thing", { account: "x" })).toBeUndefined();
    expect(detPartsOf("watchlist.removed", {})).toBeUndefined();
  });
});

describe("gid.md section 8 vectors through detPartsOf", () => {
  const account = gidFrom({ table: "accounts", parts: ["iban", "00000000000000000000000000"] });
  const ext = gidFrom({ table: "accounts", parts: ["ext", "mbank", "eb:TESTUID0001"] });
  const instrument = gidFrom(
    detPartsOf("instrument.created", { creationAlias: "isin:XX0000000001" }),
  );

  it("core and budget", () => {
    expect(gidFrom(detPartsOf("module.enabled", { moduleId: "budget" }))).toBe(
      "fdb0a016-38e3-8d64-8dec-88673f5cdcda",
    );
    expect(
      gidFrom(detPartsOf("balance.recorded", { account, date: "2026-01-31", source: "csv" })),
    ).toBe("e912848f-6071-8821-89fb-56c500920eb6");
    const dedupHash = "451a4e645c5442bf030c14db4e9674a3592a8486";
    expect(gidFrom(detPartsOf("txn.imported", { account, dedupHash, occurrence: 0 }))).toBe(
      "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0",
    );
    expect(gidFrom(detPartsOf("txn.imported", { account, dedupHash, occurrence: 1 }))).toBe(
      "7a9a8c41-5f11-8b3c-94d7-114812fc0227",
    );
    expect(gidFrom(detPartsOf("categoryRule.set", { merchantKey: "SKLEP TESTOWY" }))).toBe(
      "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2",
    );
    expect(gidFrom(detPartsOf("loan.termsSet", { account }))).toBe(
      "b3120349-b79c-869e-819b-cd2c34f608d0",
    );
    expect(gidFrom(detPartsOf("budgetSettings.cushionSet", {}))).toBe(
      "d3f2d51c-4a38-8fbf-be36-7abc2d765266",
    );
    expect(
      gidFrom(detPartsOf("connectorBinding.set", { account: ext, connectorId: "example-broker" })),
    ).toBe("6ad703ab-383d-8c73-82a5-1ee2d6742735");
  });

  it("investments", () => {
    expect(instrument).toBe("fc9daa13-f073-8a72-8cd0-c1345436bc05");
    expect(
      gidFrom(detPartsOf("instrument.aliasAdded", { namespace: "yahoo", value: "TEST.WA" })),
    ).toBe("20157f67-f236-82f9-ab83-c6d176f65f27");
    const dedupHash = "a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e";
    expect(gidFrom(detPartsOf("invTxn.imported", { account: ext, dedupHash }))).toBe(
      "f4948051-edd0-8710-babe-0f15b44cc19a",
    );
    expect(gidFrom(detPartsOf("watchlist.added", { instrument }))).toBe(
      "d0a95ad2-2211-8a30-b04b-809c6be84b30",
    );
    expect(gidFrom(detPartsOf("topicThesis.ownerSaved", { segment: "gold" }))).toBe(
      "21465e71-86fc-8535-ab21-87bbe3ca85ba",
    );
  });
});
