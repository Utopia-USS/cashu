import { describe, expect, it } from "vitest";
import { ref } from "../privacy/labels.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { decodeEntityRef, encodeEntityRef } from "./refs.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UUID = "8b245b1d-7972-8c4e-9b39-7de914604848";
const NUMERIC_ULID = "01234567890123456789012345";
const NUMERIC_UUID = "12345678-9012-8000-8000-123456789012";
describe("opaque global references", () => {
  it.each([
    "instrument",
    "signal",
    "thesis",
    "alert",
    "account",
    "loan",
    "run",
    "note",
    "watchlist",
  ] as const)("keeps %s identities distinct through the unchanged privacy boundary", (kind) => {
    for (const gid of [ULID, UUID, NUMERIC_ULID, NUMERIC_UUID]) {
      const encoded = encodeEntityRef(kind, gid);
      expect(decodeEntityRef(kind, encoded)).toBe(gid);
      expect(() => decodeEntityRef("review", encoded)).toThrow();
      for (const privacy of ["strict", "amounts"] as const) {
        const redactor = new Redactor({ privacy });
        const output = redactor.apply({ reference: ref(encoded) });
        expect(() =>
          leakCheck(output, {
            strict: redactor.strict,
            isins: redactor.isins,
            nonMoney: redactor.nonMoney,
          }),
        ).not.toThrow();
      }
    }
  });
  describe.each(["strict", "amounts"] as const)("%s privacy", (privacy) => {
    it.each([ULID, UUID, NUMERIC_ULID, NUMERIC_UUID])(
      "round trips %s through the full privacy pipeline",
      (gid) => {
        const encoded = encodeEntityRef("review", gid);
        const redactor = new Redactor({ privacy });
        const output = redactor.apply({ review_id: ref(encoded) });
        expect(output).toEqual({ review_id: encoded });
        expect(() =>
          leakCheck(output, {
            strict: redactor.strict,
            isins: redactor.isins,
            nonMoney: redactor.nonMoney,
          }),
        ).not.toThrow();
        expect(encoded).toMatch(/^review:(?:u[a-p]{52}|v[a-p]{32})$/);
        expect(decodeEntityRef("review", encoded)).toBe(gid);
      },
    );
  });
  it.each([
    "review:1",
    "review:01arz3ndektsv4rrffq69g5fav-extra",
    "other:01arz3ndektsv4rrffq69g5fav",
    "review:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "review:81arz3ndektsv4rrffq69g5fav",
    `review:x${"a".repeat(52)}`,
    `review:u${"a".repeat(51)}`,
    `review:u${"a".repeat(53)}`,
    `review:v${"a".repeat(31)}`,
    `review:v${"a".repeat(33)}`,
    `review:u${"a".repeat(52)}`,
    `review:v${"a".repeat(32)}`,
    `review:u${"q".repeat(52)}`,
  ])("refuses malformed or wrong-kind reference %s", (value) => {
    expect(() => decodeEntityRef("review", value)).toThrow();
  });
  it.each([ULID, UUID])("rejects case changes and wrong namespaces for %s", (gid) => {
    const encoded = encodeEntityRef("review", gid);
    expect(() => decodeEntityRef("review", encoded.toUpperCase())).toThrow();
    expect(() => decodeEntityRef("review", `review:${encoded.slice(7).toUpperCase()}`)).toThrow();
    expect(() => decodeEntityRef("review", encoded.replace("review:", "other:"))).toThrow();
  });
  it.each([
    ULID.toLowerCase(),
    `8${ULID.slice(1)}`,
    `${ULID}\n`,
    UUID.toUpperCase(),
    UUID.replace("-8c4e-", "-7c4e-"),
  ])("refuses a noncanonical source gid %s", (gid) => {
    expect(() => encodeEntityRef("review", gid)).toThrow();
  });
});
