// S26 spec 4.3 (budget.json with the leniency of Python `budget/settings.py`), 4.4 (archive blob
// refs), 4.8 D-G7 (strategy files compared, never an event). Synthetic only.
import { describe, expect, it } from "vitest";
import { archiveRef, readCushion, strategyFilesDiffering } from "./files.js";
import type { InvImportBatchRow } from "./rows.js";
import { memoryFiles } from "./testing/genesisData.js";

const utf8 = new TextEncoder();
const budget = (text: string | Uint8Array) =>
  readCushion(
    memoryFiles([["profiles/p/budget.json", typeof text === "string" ? utf8.encode(text) : text]]),
    "p",
  );
const DEFAULTS = {
  enabled: false,
  currency: null,
  targetAmount: null,
  targetMonths: null,
  accountIds: [],
  monthlyMax: null,
};

describe("readCushion (settings.py load / parse)", () => {
  it("parses like Python: decimals quantized to 0.01, currency stripped and upper-cased, ids deduplicated", () => {
    const file = budget(
      '{"cushion": {"enabled": true, "currency": " eur ", "target_amount": 1234.567, "monthly_max": "200", "target_months": 3.0, "account_ids": [2, 1, 2]}, "other": 1}',
    );
    expect(file).toEqual({
      kind: "ok",
      cushion: {
        enabled: true,
        currency: "EUR",
        targetAmount: "1234.57",
        targetMonths: 3,
        accountIds: [2, 1],
        monthlyMax: "200.00",
      },
    });
  });

  it("gives the defaults for null, a missing cushion and falsy id lists", () => {
    expect(budget("null")).toEqual({ kind: "ok", cushion: DEFAULTS });
    expect(budget("{}")).toEqual({ kind: "ok", cushion: DEFAULTS });
    for (const ids of ["0", "false", '""', "{}", "[]", "null"]) {
      expect(budget(`{"cushion": {"account_ids": ${ids}, "target_amount": ""}}`)).toEqual({
        kind: "ok",
        cushion: DEFAULTS,
      });
    }
  });

  it("treats a missing file as missing and every Python refusal as invalid", () => {
    expect(readCushion(memoryFiles([]), "p")).toEqual({ kind: "missing" });
    for (const text of [
      "{not json",
      '{"cushion": {"enabled": null}}',
      '{"cushion": {"enabled": true}}',
      '{"cushion": {"currency": "PLNN"}}',
      '{"cushion": {"target_amount": 0}}',
      '{"cushion": {"target_amount": true}}',
      '{"cushion": {"target_amount": "NaN"}}',
      '{"cushion": {"target_months": 37}}',
      '{"cushion": {"target_months": 2.5}}',
      '{"cushion": {"account_ids": [0]}}',
      '{"cushion": {"account_ids": [true]}}',
      '{"cushion": []}',
      "[]",
    ]) {
      expect(budget(text), text).toEqual({ kind: "invalid" });
    }
    expect(budget(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toEqual({ kind: "invalid" });
    expect(budget(Uint8Array.from([0xff]))).toEqual({ kind: "invalid" });
  });
});

describe("strategyFilesDiffering (D-G7)", () => {
  const files = memoryFiles([["profiles/p/strategy.yaml", utf8.encode("a: 1\n")]]);
  it("compares both files with the latest version's texts, bytes as UTF-8", () => {
    expect(strategyFilesDiffering(files, "p", { yamlText: "a: 1\n", mdText: null })).toBe(0);
    expect(strategyFilesDiffering(files, "p", { yamlText: "a: 2\n", mdText: "# x" })).toBe(2);
    expect(strategyFilesDiffering(files, "p", undefined)).toBe(1);
    expect(strategyFilesDiffering(memoryFiles([]), "p", undefined)).toBe(0);
  });
});

describe("archiveRef (spec 4.4)", () => {
  const bytes = utf8.encode("x");
  const sha = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
  const row = (archivePath: string | null, fileSha256 = sha) =>
    ({ archivePath, fileSha256 }) as InvImportBatchRow;
  const files = memoryFiles([
    [`imports/p/${sha}.CSV`, bytes],
    [`imports/p/${"0".repeat(64)}.csv`, bytes],
  ]);

  it("emits {sha256, ext} only for a file whose bytes match its name and file_sha256", () => {
    const tallies: string[] = [];
    const tally = (r: string) => tallies.push(r);
    expect(archiveRef(files, row(`imports/p/${sha}.CSV`), tally)).toEqual({
      sha256: sha,
      ext: "csv",
    });
    expect(archiveRef(files, row(null), tally)).toBeUndefined();
    expect(archiveRef(files, row(`imports/p/${"1".repeat(64)}.csv`), tally)).toBeUndefined();
    expect(archiveRef(files, row(`imports/p/${"0".repeat(64)}.csv`), tally)).toBeUndefined();
    expect(archiveRef(files, row(`imports/p/${sha}.CSV`, "f".repeat(64)), tally)).toBeUndefined();
    expect(archiveRef(files, row(`../p/${sha}.csv`), tally)).toBeUndefined();
    expect(archiveRef(files, row(`imports/p/${sha}.toolongextension`), tally)).toBeUndefined();
    expect(tallies).toEqual([
      "archive_missing",
      "archive_hash_mismatch",
      "archive_hash_mismatch",
      "archive_invalid",
      "archive_invalid",
    ]);
  });
});
