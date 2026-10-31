// Polish matching data the budget store writes (S24 8.7, R7): byte-identical to what Python writes
// (`src/cashu/modules/budget/cash.py`), pinned by the SHA-256 of the UTF-8 bytes so a normalization
// or an editor's re-encoding fails here. The Python line is checked too while the Python app exists.
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { CASH_WITHDRAWAL_TEXT } from "./derive/legs.js";

const PYTHON_CASH = new URL("../../../../src/cashu/modules/budget/cash.py", import.meta.url);
const hash = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

describe("budget matching data", () => {
  it("the cash leg text", () => {
    expect(hash(CASH_WITHDRAWAL_TEXT)).toBe(
      "b49322d3a94a4260e3b27e410f7d890e44a6f343709ff45c1d816d06a38dc302",
    );
    if (existsSync(PYTHON_CASH)) {
      expect(readFileSync(PYTHON_CASH, "utf8")).toContain(`reference="${CASH_WITHDRAWAL_TEXT}"`);
    }
  });
});
