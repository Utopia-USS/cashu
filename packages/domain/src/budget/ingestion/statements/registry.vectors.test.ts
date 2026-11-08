/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { InstitutionRegistry, institution } from "../../../core/index.js";
import { loadVectors } from "../../../testing/vectors.js";
import { fixtureBytes } from "../testing/fixtures.js";
import { csvBankIds, detectBank, parseBankStatement, parseStatementFile } from "./registry.js";

const files = loadVectors("budget-statements").rows as [
  string,
  string,
  unknown,
  string | null,
  unknown,
][];

/**
 * Quoted Erste exports without a bank name: Python's `match_score` split the first line at every `,`
 * and missed them (detect -> None); the TS port also reads the line as a csv record (FIX(Q4), a known
 * intentional difference).
 */
const Q4_FIXED = ["erste/erste-historia.csv", "erste/erste-quoted-no-bank.csv"];

describe("detection (csv_import.detect_importer)", () => {
  const registry = new InstitutionRegistry();

  it("the built-in registry has exactly the three CSV banks, in order", () => {
    expect(csvBankIds(registry)).toEqual(["mbank", "erste", "pekao"]);
  });

  it("detects every fixture as Python does, except the quoted Erste exports (Q4)", () => {
    for (const [, rel, , detected] of files) {
      const want = Q4_FIXED.includes(rel) ? "erste" : detected;
      expect([rel, detectBank(fixtureBytes(rel), registry)]).toEqual([rel, want]);
    }
    for (const rel of Q4_FIXED) expect(files.find((f) => f[1] === rel)?.[3]).toBeNull();
  });

  it("the Q4 fix changes no hash: those files parse the same whichever way they are found", () => {
    for (const rel of Q4_FIXED) {
      const bytes = fixtureBytes(rel);
      expect(parseStatementFile(bytes, registry)).toEqual(parseBankStatement(bytes, "erste"));
    }
  });

  it("Q4 never overrides Python: a quoted summary row before an mBank export stays mBank (review F1)", () => {
    const bytes = fixtureBytes("mbank/mbank-quoted-summary-first.csv");
    expect(files.find((f) => f[1] === "mbank/mbank-quoted-summary-first.csv")?.[3]).toBe("mbank");
    expect(detectBank(bytes, registry)).toBe("mbank");
    const parsed = parseStatementFile(bytes, registry);
    expect(parsed.ok && parsed.statement.transactions.length).toBe(1);
  });

  it("parse_file: an explicit unknown or CSV-less institution, and an undetectable file", () => {
    const bytes = fixtureBytes("mbank/mbank-edge.csv");
    expect(parseStatementFile(bytes, registry, "nope")).toEqual({
      ok: false,
      reason: "unknown_bank",
    });
    expect(parseStatementFile(bytes, registry, "revolut")).toEqual({
      ok: false,
      reason: "unknown_bank",
    });
    expect(parseStatementFile(new Uint8Array([0x61]), registry)).toEqual({
      ok: false,
      reason: "not_detected",
    });
    const extra = new InstitutionRegistry();
    extra.register(institution("moj-bank", "bank", "Mój Bank", { csvImporter: "mbank" }));
    expect(parseStatementFile(bytes, extra, "moj-bank")).toEqual(
      parseBankStatement(bytes, "mbank"),
    );
  });
});
