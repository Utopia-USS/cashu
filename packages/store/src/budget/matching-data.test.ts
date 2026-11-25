// Polish matching data the budget store writes (the domain constant `budget.CASH_LEG_TEXT`) (S24 8.7, R7):
// byte-identical to what the retired Python app wrote, pinned by the SHA-256 of the UTF-8 bytes so a
// normalization or an editor's re-encoding fails here.
import { budget } from "@cashu/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

const hash = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

describe("budget matching data", () => {
  it("the cash leg text", () => {
    expect(hash(budget.CASH_LEG_TEXT)).toBe(
      "b49322d3a94a4260e3b27e410f7d890e44a6f343709ff45c1d816d06a38dc302",
    );
  });
});
