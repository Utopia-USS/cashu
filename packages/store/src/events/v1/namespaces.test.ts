/// <reference types="node" />
// Recomputes every namespace and the gid.md section 8 vectors with an independent UUIDv5 (node:crypto
// sha1). The vectors were produced with Python's uuid.uuid5, so this pins TS == Python.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  detInput,
  GID_NAMESPACES,
  type GidNamespace,
  NAMESPACE_NAME_PREFIX,
  ROOT_NAMESPACE,
  UNIT_SEPARATOR,
} from "./namespaces.js";
import { UUID5_RE } from "./primitives.js";

function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const VAULT = "01JC0Z8Y3K7M4N5P6Q8R9S0T1V";
const det = (table: GidNamespace, ...parts: string[]) =>
  uuidv5(GID_NAMESPACES[table], detInput(VAULT, parts));
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("gid namespaces", () => {
  it("derives every table namespace from the root", () => {
    for (const [table, ns] of Object.entries(GID_NAMESPACES)) {
      expect(uuidv5(ROOT_NAMESPACE, NAMESPACE_NAME_PREFIX + table), table).toBe(ns);
      expect(ns).toMatch(UUID5_RE);
    }
  });

  it("has unique namespaces", () => {
    const values = Object.values(GID_NAMESPACES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("rejects a part containing the unit separator", () => {
    expect(() => detInput(VAULT, [`a${UNIT_SEPARATOR}b`])).toThrow(RangeError);
    expect(detInput(VAULT, ["a", "b"])).toBe(`${VAULT}\u001fa\u001fb`);
  });
});

describe("gid.md section 8 vectors (Python uuid.uuid5)", () => {
  const account = det("accounts", "mbank", "csv:XX00TEST0000");
  const instrument = det("inv_instruments", "isin:XX0000000001");

  it("core and budget", () => {
    expect(account).toBe("98ff7ab1-8526-5a5c-815d-422cd15b31c2");
    expect(det("profile_modules", "budget")).toBe("1239cec0-c343-59e3-bdfe-159fcca7620a");
    expect(det("balances", account, "2026-01-31", "csv")).toBe(
      "2895fd82-83e5-516f-b529-dd8b14b9d593",
    );
    const contentKey = "2026-01-15|-12.50|PLN|sklep testowy|zakup testowy";
    const hash = sha1(contentKey);
    expect(hash).toBe("2568e841250298bd2055a257b85edbbc85c62f4d");
    expect(det("transactions", account, hash, "0")).toBe("e54226c2-20a0-5446-87ad-434dcaba844f");
    expect(det("transactions", account, hash, "1")).toBe("fb31828f-c74f-5e66-9fbc-1697ae297b62");
    expect(det("category_rules", "sklep testowy")).toBe("de31fa28-417c-5ae4-bc5a-0c5fb76447cd");
    expect(det("loans", account)).toBe("c204aed4-bddb-5da2-ad36-d809765bff6d");
    expect(det("budget_settings", "cushion")).toBe("6134d30b-4490-5b3b-97d7-6aaf8e817e96");
  });

  it("investments", () => {
    expect(instrument).toBe("ebc1e39a-6334-5bf0-b460-b9c91d334f08");
    expect(det("inv_instrument_aliases", "yahoo", "TEST.WA")).toBe(
      "4df2d5a6-39dd-535f-b365-779154d394db",
    );
    const contentKey = ["2026-02-03", "buy", instrument, "10", "12.5", "125", "-125.5"].join(
      UNIT_SEPARATOR,
    );
    const hash = sha256(["v2", "content", account, contentKey, "0"].join(UNIT_SEPARATOR));
    expect(hash).toBe("7c0d704bad6cb7238245d48c90add9638e576044f2c77f6cfb037562957f6b44");
    expect(det("inv_transactions", account, hash)).toBe("316c3ae3-40c0-5245-8e9b-867aafe9bfe4");
    expect(det("inv_signals", `drawdown_check|i:${instrument}`, "2026-03-02", "0")).toBe(
      "df88f798-b625-59cb-a6c9-376b4d9d27fa",
    );
    expect(det("watchlist_items", instrument)).toBe("d5e6bdd6-3558-56be-b446-ec83cddc4c8c");
    expect(det("inv_topic_theses", "gold")).toBe("d09c21ce-7d2e-57fa-8a1a-4cb8590c8df4");
  });

  it("genesis gids of ULID tables", () => {
    expect(det("genesis", "inv_theses", "7")).toBe("84370644-081f-547f-91bc-baab644fc5c8");
  });
});
