/// <reference types="node" />
import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../../../testing/vectors.js";
import { canonicalOut } from "../testing/canonicalOut.js";
import type { TxnSource } from "../types.js";

const rows = loadVectors("budget-canonical").rows as [string, string, string, TxnSource, unknown][];
const SLICE = 100;
const slices = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);

describe("cashu-budget-import vectors (canonical.py via vectors_budget.py)", () => {
  it.each(slices)(
    "rows %i.. : issues (kind, row, field, message, blocking, order), statements, reports, detection equal Python",
    (start) => {
      const m = new Mismatches();
      for (const [i, [, b64, name, source, want]] of rows.slice(start, start + SLICE).entries()) {
        const got = canonicalOut(new Uint8Array(Buffer.from(b64, "base64")), name, source);
        m.check(`#${start + i} ${name} ${b64.slice(0, 40)}`, got, want);
      }
      expectAll(m);
    },
  );
});
