import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { bankingUiAction } from "./uiAction.js";

afterEach(cleanup);

it("rejects a forged configure action before any runtime or key-file access", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()) });
  try {
    const vaultId = [...host.stores.vaults.keys()][0];
    if (!vaultId) throw new Error("synthetic vault missing");
    let requested = false;
    const action = bankingUiAction(() => {
      requested = true;
      return undefined;
    });
    expect(
      await action.run(host.stores, vaultId, {
        type: "configure",
        appId: "synthetic-app",
        keyFilePath: join(realpathSync(tmpdir()), "forged.pem"),
      }),
    ).toEqual({ status: "refused", reason: "invalid_input", preparation: "none" });
    expect(requested).toBe(false);
  } finally {
    await host.stop();
  }
});
