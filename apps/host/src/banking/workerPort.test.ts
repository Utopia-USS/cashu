import { expect, it } from "vitest";
import type { OpenVault } from "../stores.js";
import type { BankingRuntime } from "./runtime.js";
import { bankingWorkerPort } from "./workerPort.js";

it("reports processed bank sessions separately from imported accounts", async () => {
  const runtime = {
    service: () => ({
      status: async () => ({ configured: true, sessions: [{ handle: "synthetic" }] }),
      sync: async () => ({ banks: 1, accounts: 2, inserted: 3, errors: [], attempts: [] }),
    }),
  } as unknown as BankingRuntime;
  const vault = { mode: "native" } as OpenVault;
  const port = bankingWorkerPort(runtime);
  const guard = () => undefined;
  expect(await port.configured(vault)).toBe(true);
  expect(await port.sync(vault, 90, guard)).toEqual({
    ok: true,
    banks: 1,
    inserted: 3,
    errors: [],
  });
});
