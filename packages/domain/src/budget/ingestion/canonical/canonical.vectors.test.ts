/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { loadVectors, Mismatches } from "../../../testing/vectors.js";
import { canonicalOut } from "../testing/canonicalOut.js";
import type { TxnSource } from "../types.js";

describe("cashu-budget-import vectors (canonical.py via vectors_budget.py)", () => {
  it("issues (kind, row, field, message, blocking, order), statements, reports and detection equal Python", () => {
    const m = new Mismatches();
    const rows = loadVectors("budget-canonical").rows;
    for (const [i, row] of rows.entries()) {
      const [, b64, name, source, want] = row as [string, string, string, TxnSource, unknown];
      m.check(
        `#${i} ${name} ${b64.slice(0, 40)}`,
        canonicalOut(new Uint8Array(Buffer.from(b64, "base64")), name, source),
        want,
      );
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(rows.length);
  });
});
