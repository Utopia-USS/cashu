// gid.md section 8 vectors (produced with Python hmac / hashlib) against the runtime HMAC.
import { describe, expect, it } from "vitest";
import { ULID_RE, UUID8_RE } from "./events/v1/primitives.js";
import { detGid, mintUlid, newVaultSalt, vaultSalt } from "./gid.js";
import { rng, TEST_SALT } from "./testing/store.js";

const IBAN_ACC = "70cc61c8-79b5-80ae-b8cc-fdca7caef49e";
const EXT_ACC = "a1bb665d-9bf1-81e3-916c-f49d32db099a";
const TXN = "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0";
const INST = "fc9daa13-f073-8a72-8cd0-c1345436bc05";

const VECTORS: [Parameters<typeof detGid>[1], string[], string][] = [
  ["accounts", ["iban", "00000000000000000000000000"], IBAN_ACC],
  ["accounts", ["ext", "mbank", "eb:TESTUID0001"], EXT_ACC],
  ["profile_modules", ["budget"], "fdb0a016-38e3-8d64-8dec-88673f5cdcda"],
  ["balances", [IBAN_ACC, "2026-01-31", "csv"], "e912848f-6071-8821-89fb-56c500920eb6"],
  ["transactions", [IBAN_ACC, "451a4e645c5442bf030c14db4e9674a3592a8486", "0"], TXN],
  [
    "transactions",
    [IBAN_ACC, "451a4e645c5442bf030c14db4e9674a3592a8486", "1"],
    "7a9a8c41-5f11-8b3c-94d7-114812fc0227",
  ],
  ["transactions", ["cashleg", TXN], "95c48228-d6ec-8832-83ad-15ba530cfe8f"],
  ["category_rules", ["SKLEP TESTOWY"], "cc9078fc-ae3d-8c1d-8381-55311fb4c8b2"],
  ["loans", [IBAN_ACC], "b3120349-b79c-869e-819b-cd2c34f608d0"],
  ["budget_settings", ["cushion"], "d3f2d51c-4a38-8fbf-be36-7abc2d765266"],
  ["connector_bindings", [EXT_ACC, "example-broker"], "6ad703ab-383d-8c73-82a5-1ee2d6742735"],
  ["inv_instruments", ["isin:XX0000000001"], INST],
  ["inv_instrument_aliases", ["yahoo", "TEST.WA"], "20157f67-f236-82f9-ab83-c6d176f65f27"],
  [
    "inv_transactions",
    [EXT_ACC, "a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e"],
    "f4948051-edd0-8710-babe-0f15b44cc19a",
  ],
  ["watchlist_items", [INST], "d0a95ad2-2211-8a30-b04b-809c6be84b30"],
  ["inv_topic_theses", ["gold"], "21465e71-86fc-8535-ab21-87bbe3ca85ba"],
  ["genesis", ["inv_theses", "7"], "c1e52d4d-d9a5-84e6-8d7a-c21b36691202"],
];

describe("keyed DET gids", () => {
  it.each(VECTORS)("%s %j", (table, parts, expected) => {
    const g = detGid(TEST_SALT, table, parts);
    expect(g).toBe(expected);
    expect(g).toMatch(UUID8_RE);
  });

  it("depends on the salt: another vault gets unrelated gids", () => {
    const other = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => 31 - i));
    expect(detGid(other, "category_rules", ["SKLEP TESTOWY"])).not.toBe(VECTORS[7]?.[2]);
    expect(newVaultSalt().bytes).toHaveLength(32);
  });

  it("refuses a salt of the wrong length and a part with the unit separator", () => {
    expect(() => vaultSalt(new Uint8Array(16))).toThrow(RangeError);
    expect(() => detGid(TEST_SALT, "accounts", ["a\u001fb"])).toThrow(RangeError);
  });
});

describe("ULIDs", () => {
  it("mints sortable, valid ULIDs", () => {
    const r = rng(1);
    const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
    const a = mintUlid(1_793_448_000_000, random);
    const b = mintUlid(1_793_448_000_001, random);
    expect(a).toMatch(ULID_RE);
    expect(a < b).toBe(true);
    expect(mintUlid(Date.now())).toMatch(ULID_RE);
  });
});
