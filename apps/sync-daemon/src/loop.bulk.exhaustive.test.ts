// Real multi-frame import with 2500 events. Serial exhaustive tier avoids competing with
// every package's default tests; the input, assertions and 5 s test limit are unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupLoop, logOf, runLoop, world } from "./testing/loop.js";

const GID_A = "01JQ0000000000000000000001";
afterEach(cleanupLoop);

describe("the loop bulk import", () => {
  it("ships a large import (one transaction, several frames) as one atomic write (S29c-B3)", async () => {
    const w = await world(1);
    const rows = 2500;
    for (let i = 0; i < rows; i++) {
      const gid = `01JQ${String(i + 1).padStart(22, "0")}`;
      w.py.editAlert(1, 100 + i, gid, `bulk-${i}`, {}, "txn-import");
    }
    w.py.editAlert(1, 5, GID_A, "after-import");
    const run = await runLoop(w);
    expect(run.crashed).toBe(false);
    expect(w.py.pending()).toBe(0);
    const [v] = run.vaults;
    if (v === undefined) throw new Error("vault");
    expect(logOf(v)).toMatchObject({ count: rows + 1, distinct: rows + 1 });
    // The import went out as one frame group in one write: its frames sit in one segment, and a
    // reader that opens the vault from the log applies it as one batch.
    const segs = (await v.local.list(v.vaultId)).filter((s) => s.device === v.device);
    expect(segs.map((s) => s.seg)).toEqual([1]);
    expect(run.cli.acks.map((a) => a.through)).toEqual([rows, rows + 1]);
    await run.close();
  });
});
