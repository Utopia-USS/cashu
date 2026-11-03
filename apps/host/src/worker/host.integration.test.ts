import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { emptyWorkerState, type WorkerBindings, type WorkerHostContext } from "./contracts.js";

afterEach(cleanup);

it("starts off by default, then reports safe mode without running an injected worker", async () => {
  const dir = tempDir();
  const first = await startLocalHost(testHostOptions(dir));
  expect(first.status().worker?.state).toBe("off");
  await first.stop();
  const now = Date.now();
  writeFileSync(
    join(dir, "run", "starts.json"),
    JSON.stringify({ format: 1, unclean: [now - 3000, now - 2000, now - 1000] }),
  );
  let loads = 0;
  const bindings: WorkerBindings = {
    state: {
      load: async () => {
        loads += 1;
        return emptyWorkerState();
      },
      save: async () => {},
    },
    ownership: { isExclusive: () => false },
    authority: () => null,
    language: () => "en",
  };
  const safe = await startLocalHost({ ...testHostOptions(dir), worker: () => bindings });
  try {
    expect(safe.safeMode).toBe(true);
    expect(safe.status().worker?.state).toBe("safe-mode");
    expect(loads).toBe(0);
  } finally {
    await safe.stop();
  }
});

it("forwards a real host worker option and waits for an in-flight provider before closing stores", async () => {
  const dir = tempDir();
  let entered!: () => void;
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  let context: WorkerHostContext | undefined;
  const host = await startLocalHost({
    ...testHostOptions(dir),
    worker: (current) => {
      context = current;
      return {
        state: {
          load: async () => {
            entered();
            await gate;
            return emptyWorkerState();
          },
          save: async () => {
            writes += 1;
          },
        },
        ownership: { isExclusive: () => false },
        authority: () => null,
        language: () => "en",
      };
    },
  });
  try {
    await loading;
    const vault = [...host.stores.vaults.values()][0];
    if (vault === undefined || context === undefined)
      throw new Error("synthetic worker context is absent");
    expect(context.isCurrent(vault)).toBe(true);
    const admin = await connectHost({ dataDir: dir, role: "admin", build: "test" });
    try {
      const status = adminStatusResultSchema.parse(await admin.call("admin.status"));
      expect(status.worker).toMatchObject({ state: "running", jobs: [] });
    } finally {
      admin.close();
    }
    let stopped = false;
    const stopping = host.stop().then((code) => {
      stopped = true;
      return code;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(context.isCurrent(vault)).toBe(false);
    release();
    expect(await stopping).toBe(0);
    expect(host.status().worker?.state).toBe("stopped");
    expect(writes).toBe(0);
  } finally {
    release();
    await host.stop();
  }
});
