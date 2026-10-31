/// <reference types="node" />
// Recomputes the gid.md section 8 vectors with node:crypto HMAC-SHA256. The vectors were produced
// with Python's hmac + hashlib on the same fixed test salt, so this pins TS == Python.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  detMessage,
  GID_DOMAIN_PREFIX,
  GID_TABLES,
  type GidTable,
  UNIT_SEPARATOR,
  uuid8FromDigest,
  VAULT_SALT_BYTES,
} from "./namespaces.js";
import { UUID8_RE } from "./primitives.js";

/** Fixed TEST salt (bytes 0x00..0x1f). Real salts are random per vault. */
const SALT = Buffer.from(Array.from({ length: VAULT_SALT_BYTES }, (_, i) => i));
const det = (table: GidTable, ...parts: string[]) =>
  uuid8FromDigest(createHmac("sha256", SALT).update(detMessage(table, parts), "utf8").digest());
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("keyed gid construction", () => {
  it("lays out the message as prefix+table then parts, separated by U+001F", () => {
    expect(detMessage("loans", ["a", "b"])).toBe(`${GID_DOMAIN_PREFIX}loans\u001fa\u001fb`);
    expect(() => detMessage("loans", [`a${UNIT_SEPARATOR}b`])).toThrow(RangeError);
  });

  it("formats a UUIDv8 and has unique table names", () => {
    expect(det("loans", "x")).toMatch(UUID8_RE);
    expect(new Set(GID_TABLES).size).toBe(GID_TABLES.length);
  });

  it("depends on the salt (no salt, no confirmation)", () => {
    const other = Buffer.alloc(VAULT_SALT_BYTES, 7);
    const msg = detMessage("category_rules", ["SKLEP TESTOWY"]);
    const a = uuid8FromDigest(createHmac("sha256", SALT).update(msg).digest());
    const b = uuid8FromDigest(createHmac("sha256", other).update(msg).digest());
    expect(a).not.toBe(b);
  });
});

describe("gid.md section 8 vectors (Python hmac, test salt 00..1f)", () => {
  const account = det("accounts", "iban", "00000000000000000000000000");
  const brokerage = det("accounts", "ext", "mbank", "eb:TESTUID0001");
  const instrument = det("inv_instruments", "isin:XX0000000001");

  it("core and budget", () => {
    expect(account).toBe("70cc61c8-79b5-80ae-b8cc-fdca7caef49e");
    expect(brokerage).toBe("a1bb665d-9bf1-81e3-916c-f49d32db099a");
    expect(det("profile_modules", "budget")).toBe("fdb0a016-38e3-8d64-8dec-88673f5cdcda");
    expect(det("balances", account, "2026-01-31", "csv")).toBe(
      "e912848f-6071-8821-89fb-56c500920eb6",
    );
    const hash = sha1("2026-01-15|-12.50|PLN|SKLEP TESTOWY|ZAKUP TESTOWY");
    expect(hash).toBe("451a4e645c5442bf030c14db4e9674a3592a8486");
    const txn = det("transactions", account, hash, "0");
    expect(txn).toBe("0b7c2348-a233-87ef-9f1b-4b5bd5161ee0");
    expect(det("transactions", account, hash, "1")).toBe("7a9a8c41-5f11-8b3c-94d7-114812fc0227");
    expect(det("transactions", "cashleg", txn)).toBe("95c48228-d6ec-8832-83ad-15ba530cfe8f");
    expect(det("category_rules", "SKLEP TESTOWY")).toBe("cc9078fc-ae3d-8c1d-8381-55311fb4c8b2");
    expect(det("loans", account)).toBe("b3120349-b79c-869e-819b-cd2c34f608d0");
    expect(det("budget_settings", "cushion")).toBe("d3f2d51c-4a38-8fbf-be36-7abc2d765266");
    expect(det("connector_bindings", brokerage, "example-broker")).toBe(
      "6ad703ab-383d-8c73-82a5-1ee2d6742735",
    );
  });

  it("investments", () => {
    expect(instrument).toBe("fc9daa13-f073-8a72-8cd0-c1345436bc05");
    expect(det("inv_instrument_aliases", "yahoo", "TEST.WA")).toBe(
      "20157f67-f236-82f9-ab83-c6d176f65f27",
    );
    const content = ["2026-02-03", "buy", "testbroker:TST", "10", "12.5", "125", "-125.5"].join(
      UNIT_SEPARATOR,
    );
    const hash = sha256(["v2", "content", brokerage, content, "0"].join(UNIT_SEPARATOR));
    expect(hash).toBe("a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e");
    expect(det("inv_transactions", brokerage, hash)).toBe("f4948051-edd0-8710-babe-0f15b44cc19a");
    expect(det("watchlist_items", instrument)).toBe("d0a95ad2-2211-8a30-b04b-809c6be84b30");
    expect(det("inv_topic_theses", "gold")).toBe("21465e71-86fc-8535-ab21-87bbe3ca85ba");
  });

  it("genesis gids of ULID tables", () => {
    expect(det("genesis", "inv_theses", "7")).toBe("c1e52d4d-d9a5-84e6-8d7a-c21b36691202");
  });
});
