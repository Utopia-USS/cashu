// The daemon loop's exactly-once and crash recovery (S31a spec 6.2, 6.3) and the D4 block, over a
// synthetic Python database, a fake `cashu` CLI and real vaults (node:sqlite view, Node folder log,
// libsodium codec) in temp dirs. A crash is a throw at a crash point followed by reopening every
// vault from disk. Synthetic data only.
import { afterEach, describe, expect, it } from "vitest";
import { BlockedError, Loop } from "./loop.js";
import { PythonReader } from "./python/reader.js";
import { cleanupLoop, logOf, openAll, ports, runLoop, world } from "./testing/loop.js";

const GID_A = "01JQ0000000000000000000001";
const GID_B = "01JQ0000000000000000000002";
afterEach(cleanupLoop);

describe("the loop", () => {
  it("ships, acks with field clocks and leaves nothing pending", async () => {
    const w = await world(1);
    w.py.editAlert(1, 5, GID_A, "bridge-test-1");
    w.py.editAlert(1, 6, GID_B, "bridge-test-2");
    const run = await runLoop(w);
    expect(w.py.pending()).toBe(0);
    const [v] = run.vaults;
    if (v === undefined) throw new Error("vault");
    expect(logOf(v)).toMatchObject({
      count: 2,
      distinct: 2,
      types: ["alert.updated", "alert.updated"],
    });
    const ack = run.cli.acks.at(-1);
    expect(ack?.through).toBe(2);
    expect(JSON.stringify(ack?.entries)).toContain('"clocks":{"title":[');
    expect(run.lines.map((l) => l.progress).filter(Boolean)).toEqual([
      "intent",
      "written",
      "acked",
      "cleared",
    ]);
    await run.close();
  });

  it.each(["intent", "vaultWritten", "written", "acked", "vaultCleared", "cleared"] as const)(
    "recovers a crash after %s: every event once, nothing pending",
    async (point) => {
      const w = await world(2);
      w.py.editAlert(1, 5, GID_A, "bridge-test-1");
      w.py.editAlert(2, 7, GID_B, "bridge-test-2");
      const first = await runLoop(w, point);
      expect(first.crashed).toBe(true);
      await first.close();
      const second = await runLoop(w);
      expect(second.crashed).toBe(false);
      expect(w.py.pending()).toBe(0);
      for (const v of second.vaults) {
        const log = logOf(v);
        expect(log.count).toBe(1);
        expect(log.distinct).toBe(1);
      }
      await second.close();
    },
  );

  it("discards a plan whose only stored intent is a gids-only batch (crash while storing intents)", async () => {
    const w = await world(2);
    const through = w.py.editAlert(2, 7, GID_B, "bridge-test-2");
    const vaults = await openAll(w);
    const [a] = vaults;
    if (a === undefined) throw new Error("vault");
    // Vault A's intent (gids, no events) was stored; the crash came before vault B's.
    a.state.putIntent({
      planId: "01JQ0000000000000000000099",
      vaults: 2,
      through,
      batch: {
        ordinal: 0,
        profileId: 1,
        vault: a.vaultId,
        events: [],
        carries: [],
        gids: [{ table: "alerts", localId: "9", gid: "01JQ0000000000000000000098" }],
      },
    });
    for (const v of vaults) await v.close();
    const run = await runLoop(w);
    expect(w.py.pending()).toBe(0);
    const b = run.vaults[1];
    if (b === undefined) throw new Error("vault");
    expect(logOf(b).count).toBe(1); // vault B's row was shipped, not acked unwritten
    await run.close();
  });

  it("recovers an append that was durable before the local apply (view lost its events)", async () => {
    const w = await world(1);
    w.py.editAlert(1, 5, GID_A, "bridge-test-1");
    const first = await runLoop(w, "written");
    // The frame is in the local log; drop the view's copy as if the apply never committed.
    for (const v of first.vaults) v.store.reset();
    await first.close();
    const second = await runLoop(w);
    expect(w.py.pending()).toBe(0);
    const [v] = second.vaults;
    if (v === undefined) throw new Error("vault");
    expect(logOf(v)).toMatchObject({ count: 1, distinct: 1 });
    await second.close();
  });

  it("D4: an unmappable row stops the loop; nothing is written or acked", async () => {
    const w = await world(1);
    w.py.editAlert(1, 5, GID_A, "bridge-test-1", { kind: "new_high" });
    const vaults = await openAll(w);
    const reader = new PythonReader(w.py.dir);
    const cli = w.py.cli();
    const loop = new Loop({
      reader,
      cli,
      vaults,
      slugs: new Map([[1, "syn-1"]]),
      ports,
      now: () => Date.UTC(2026, 2, 2),
      out: () => undefined,
    });
    await expect(loop.iteration()).rejects.toThrow(BlockedError);
    await expect(loop.iteration()).rejects.toMatchObject({ reason: "immutable:alerts:kind" });
    expect(w.py.pending()).toBe(1);
    expect(cli.acks.length).toBe(0);
    const [v] = vaults;
    if (v === undefined) throw new Error("vault");
    expect(logOf(v).count).toBe(0);
    expect(v.state.intent()).toBeUndefined();
    for (const x of vaults) await x.close();
    reader.close();
  });
});
