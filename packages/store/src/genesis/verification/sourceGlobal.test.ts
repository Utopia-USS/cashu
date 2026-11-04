import { describe, expect, it } from "vitest";
import { genesis } from "../index.js";
import { FILES, KEYS, NOW, seededDb } from "../testing/genesisData.js";
import { auditGlobalInstruments, GlobalInstrumentAuditError } from "./sourceGlobal.js";

describe("independent global instrument accounting", () => {
  it("checks exact per-vault closure, aliases and unreferenced catalog count", () => {
    const source = seededDb("0029");
    try {
      const result = genesis({ driver: source, files: FILES }, KEYS, { strict: true, now: NOW });
      const audit = auditGlobalInstruments(source, result);
      expect(audit).toMatchObject({
        sourceInstruments: 4,
        sourceAliases: 3,
        unreferencedInstruments: 1,
        unreferencedAliases: 0,
      });
      for (const vault of audit.vaults) {
        expect(
          result.report.counters.vaults[String(vault.ordinal)]?.inv_instruments
            ?.instrument_orphan ?? 0,
        ).toBe(vault.omitted);
      }
      const first = result.vaults[0];
      if (!first) throw new Error("synthetic fixture vault missing");
      const altered = {
        ...result,
        vaults: [
          { ...first, ids: first.ids.filter((entry) => entry.table !== "inv_instrument_aliases") },
          ...result.vaults.slice(1),
        ],
      };
      expect(() => auditGlobalInstruments(source, altered)).toThrowError(
        new GlobalInstrumentAuditError(),
      );
    } finally {
      source.close();
    }
  });
});
