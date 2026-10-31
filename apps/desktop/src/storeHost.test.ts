import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ToStoreProcess } from "./storeControl.js";
import { StoreProcess, type UtilityLike } from "./storeHost.js";

class FakeUtility extends EventEmitter implements UtilityLike {
  readonly posted: { message: ToStoreProcess; transfer?: unknown[] }[] = [];
  killed = false;
  constructor(private readonly obeysStop = true) {
    super();
  }
  postMessage(message: ToStoreProcess, transfer?: unknown[]): void {
    this.posted.push(transfer === undefined ? { message } : { message, transfer });
    if (message.t === "stop" && this.obeysStop) setImmediate(() => this.emit("exit", 0));
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("exit", 9));
    return true;
  }
}

function setup(child: FakeUtility) {
  const lines: string[] = [];
  let n = 0;
  const host = new StoreProcess({
    fork: () => child,
    createChannel: () => ({ port1: `p${++n}a`, port2: `p${n}b` }),
    log: (line) => lines.push(line),
    stopTimeoutMs: 50,
  });
  return { host, lines };
}

describe("StoreProcess", () => {
  it("starts, routes one port pair per renderer and stops on request", async () => {
    const child = new FakeUtility();
    const { host, lines } = setup(child);
    const started = host.start();
    child.emit("message", { t: "log", line: "opening" });
    child.emit("message", { t: "ready", vaults: 1 });
    await started;
    const delivered: string[] = [];
    expect(host.connect((port) => delivered.push(port))).toBe(true);
    expect(host.connect((port) => delivered.push(port))).toBe(true);
    expect(delivered).toEqual(["p1b", "p2b"]);
    expect(child.posted).toEqual([
      { message: { t: "connect" }, transfer: ["p1a"] },
      { message: { t: "connect" }, transfer: ["p2a"] },
    ]);
    await host.stop();
    expect(child.killed).toBe(false);
    expect(host.connect(() => {})).toBe(false);
    expect(lines).toContain("opening");
  });

  it("rejects the start when the process exits before it is ready, and ignores unknown messages", async () => {
    const child = new FakeUtility();
    const { host, lines } = setup(child);
    const started = host.start();
    child.emit("message", { t: "nonsense" });
    child.emit("exit", 2);
    await expect(started).rejects.toThrow("exited (2)");
    expect(lines).toContain("store process: unknown message ignored");
  });

  it("kills a store process that does not stop in time", async () => {
    const child = new FakeUtility(false);
    const { host } = setup(child);
    const started = host.start();
    child.emit("message", { t: "ready", vaults: 0 });
    await started;
    await host.stop();
    expect(child.killed).toBe(true);
  });
});
