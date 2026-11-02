import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { ToolError } from "../registry.js";
import { inspectExportBytes } from "./exports.js";
import { boundedXlsxEntries, readExportXlsx } from "./exportXlsx.js";

interface Vector {
  name: string;
  content: string;
  max_samples: number;
  expected: Record<string, string>;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/exports.json", import.meta.url), "utf8"),
) as Vector[];
it.each(vectors)(
  "matches actual Python file inspection and final leak check: $name / $max_samples",
  (vector) => {
    for (const privacy of ["strict", "amounts"] as const) {
      const expected = JSON.parse(vector.expected[privacy] ?? "null");
      if (expected?.error_kind !== undefined) {
        let error: unknown;
        try {
          inspectExportBytes(
            { name: vector.name, bytes: Uint8Array.from(Buffer.from(vector.content, "base64")) },
            vector.max_samples,
          );
        } catch (failure) {
          error = failure;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ToolError);
        expect(expected.error_kind).toBe("internal");
        continue;
      }
      const redactor = new Redactor({ privacy });
      const data = redactor.apply(
        inspectExportBytes(
          { name: vector.name, bytes: Uint8Array.from(Buffer.from(vector.content, "base64")) },
          vector.max_samples,
        ),
      );
      leakCheck(data, {
        strict: redactor.strict,
        isins: redactor.isins,
        nonMoney: redactor.nonMoney,
      });
      expect(JSON.parse(pyDumps(data))).toEqual(JSON.parse(vector.expected[privacy] ?? "null"));
    }
  },
);
it("enforces declared and actual decompression budgets before retaining oversized output", () => {
  const compressed = zipSync({ "xl/test.xml": strToU8("A".repeat(30000)) });
  expect(() => boundedXlsxEntries(compressed, 1024)).toThrow("too large when unpacked");
  const forged = compressed.slice(),
    view = new DataView(forged.buffer);
  for (let i = 0; i + 46 < forged.length; i++)
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
  expect(() => boundedXlsxEntries(forged, 1024)).toThrow("too large when unpacked");
});
it("verifies CRC and rejects malformed archives, duplicate/traversal names and external XML declarations", () => {
  const plain = zipSync({ "xl/test.xml": strToU8("<x>SAFE</x>") }, { level: 0 });
  const corrupted = plain.slice();
  const at = Buffer.from(corrupted).indexOf("SAFE");
  expect(at).toBeGreaterThan(0);
  corrupted[at] = 88;
  expect(() => boundedXlsxEntries(corrupted)).toThrow("cannot be read");
  expect(() => boundedXlsxEntries(plain.subarray(0, plain.length - 1))).toThrow("cannot be opened");
  expect(() => boundedXlsxEntries(zipSync({ "../x": strToU8("x") }))).toThrow("cannot be read");
  expect(() =>
    readExportXlsx(
      zipSync({ "xl/workbook.xml": strToU8('<!DOCTYPE x [<!ENTITY e "private">]><x>&e;</x>') }),
    ),
  ).toThrow("cannot be read");
});
it("limits XLSX members and rejects duplicate central names without relying on extraction paths", () => {
  const archive = zipSync({ "xl/a": strToU8("a"), "xl/b": strToU8("b") }, { level: 0 }),
    duplicate = archive.slice();
  const token = Buffer.from(duplicate);
  let at = token.indexOf("xl/b");
  while (at >= 0) {
    duplicate[at + 3] = 97;
    at = token.indexOf("xl/b", at + 4);
  }
  expect(() => boundedXlsxEntries(duplicate)).toThrow("cannot be read");
  const count = archive.slice(),
    view = new DataView(count.buffer),
    end = count.length - 22;
  view.setUint16(end + 8, 10001, true);
  view.setUint16(end + 10, 10001, true);
  expect(() => boundedXlsxEntries(count)).toThrow("cannot be read");
});
