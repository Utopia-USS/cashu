// The per-vault queue: tasks of one vault run one at a time in order (a failing one does not stop the
// next), vaults do not wait on each other, and a closed queue refuses new work after the queued work.
import { createVaultQueue, QueueClosedError } from "./commandQueue";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("the vault queue", () => {
  it("serializes one vault, keeps order after a failure and lets another vault run", async () => {
    const queue = createVaultQueue();
    const log: string[] = [];
    const gate = deferred();
    const first = queue.run(A, async () => {
      log.push("a1 start");
      await gate.promise;
      log.push("a1 end");
    });
    const second = queue.run(A, async () => {
      log.push("a2");
      throw new Error("refused");
    });
    const third = queue.run(A, async () => {
      log.push("a3");
      return 3;
    });
    const other = queue.run(B, async () => {
      log.push("b1");
    });
    await other;
    expect(log).toEqual(["a1 start", "b1"]);
    expect(queue.pending(A)).toBe(3);
    gate.resolve();
    await first;
    await expect(second).rejects.toThrow("refused");
    await expect(third).resolves.toBe(3);
    expect(log).toEqual(["a1 start", "b1", "a1 end", "a2", "a3"]);
    expect(queue.pending(A)).toBe(0);
  });

  it("refuses work after close, once the queued work settled", async () => {
    const queue = createVaultQueue();
    const gate = deferred();
    let ran = false;
    const queued = queue.run(A, async () => {
      await gate.promise;
      ran = true;
    });
    const closing = queue.close();
    await expect(queue.run(A, async () => 1)).rejects.toBeInstanceOf(QueueClosedError);
    gate.resolve();
    await closing;
    await queued;
    expect(ran).toBe(true);
  });
});
