import { describe, expect, it } from "vitest";
import { QueueClosedError, WriteQueue } from "./queue.js";

describe("WriteQueue", () => {
  it("runs tasks one at a time in arrival order", async () => {
    const q = new WriteQueue();
    const order: number[] = [];
    const done = await Promise.all(
      [1, 2, 3].map((n) =>
        q.run(() => {
          order.push(n);
          return n * 10;
        }),
      ),
    );
    expect(done).toEqual([10, 20, 30]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("lets a task queued during a sliced job run between its slices", async () => {
    const q = new WriteQueue();
    const order: string[] = [];
    function* job(): Generator<void, string> {
      for (let i = 0; i < 5; i++) {
        order.push(`slice${i}`);
        yield;
      }
      order.push("last");
      return "done";
    }
    const sliced = q.runSliced(job());
    const single = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      q.run(() => order.push("command")),
    );
    await Promise.all([sliced, single]);
    expect(await sliced).toBe("done");
    // The command waited for at most the slice in progress, not the whole job.
    expect(order.indexOf("command")).toBeLessThanOrEqual(2);
    expect(order.at(-1)).toBe("last");
  });

  it("fails a step when the guard throws, and refuses work once closed", async () => {
    let held = true;
    const q = new WriteQueue(() => {
      if (!held) throw new Error("lease lost");
    });
    await expect(q.run(() => 1)).resolves.toBe(1);
    held = false;
    await expect(q.run(() => 2)).rejects.toThrow("lease lost");
    q.close();
    await expect(q.run(() => 3)).rejects.toBeInstanceOf(QueueClosedError);
    await q.idle();
    expect(q.pending).toBe(0);
  });

  it("holds the queue until an asynchronous task settles and drains after close", async () => {
    const q = new WriteQueue();
    const order: string[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = q.run(async () => {
      order.push("first-start");
      await barrier;
      order.push("first-end");
    });
    const second = q.run(() => order.push("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(q.pending).toBe(2);
    expect(order).toEqual(["first-start"]);
    q.close();
    const idle = q.idle().then(() => order.push("idle"));
    release();
    await Promise.all([first, second, idle]);
    expect(order).toEqual(["first-start", "first-end", "second", "idle"]);
  });
});
