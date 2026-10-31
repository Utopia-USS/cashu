/// <reference types="node" />
import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../../testing/vectors.js";
import { canonicalOut } from "./testing/vectorOut.js";

const rows = loadVectors("inv-importing-canonical").rows as [string, string, unknown][];
const SLICE = 100;
const slices = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);

describe("cashu-import vectors (canonical.py + validation.py via vectors_inv_importing.py)", () => {
  it.each(slices)(
    "rows %i.. : warnings, rows, positions, actions, detection and the validation report equal Python",
    (start) => {
      const m = new Mismatches();
      for (const [i, [b64, name, want]] of rows.slice(start, start + SLICE).entries()) {
        const got = canonicalOut(new Uint8Array(Buffer.from(b64, "base64")), name);
        m.check(`#${start + i} ${name} ${b64.slice(0, 40)}`, got, want);
      }
      expectAll(m);
    },
  );
});
