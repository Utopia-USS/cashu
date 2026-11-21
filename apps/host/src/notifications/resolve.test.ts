import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { workerFixture } from "../testing/worker.js";
import { privateNotificationIntents } from "./intentLedger.js";
import { resolveNotificationIntent } from "./resolve.js";

const dirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("resolves only the exact current admitted and unlocked vault, regardless of UI selection", async () => {
  const f = await workerFixture({ two: true });
  const target = f.vaults[1];
  if (target === undefined) throw new Error("synthetic vault absent");
  const dir = mkdtempSync(join(tmpdir(), "cashu-intent-resolve-"));
  dirs.push(dir);
  const ledger = privateNotificationIntents(
    dir,
    () => true,
    () => f.time(),
  );
  const input = { vaultId: target.id, kind: "signalsSummary" as const, locale: "en" as const };
  try {
    const locked = ledger.reserve(input);
    expect(
      await resolveNotificationIntent(
        ledger,
        f.context.stores,
        { isAdmittedAndUnlocked: () => false },
        locked.requestId,
        locked.intentToken,
        () => f.time(),
      ),
    ).toBeNull();
    expect(ledger.resolve(locked.requestId, locked.intentToken)).toBeNull();
    const valid = ledger.reserve(input);
    expect(
      await resolveNotificationIntent(
        ledger,
        f.context.stores,
        { isAdmittedAndUnlocked: (vault) => vault === target },
        valid.requestId,
        valid.intentToken,
        () => f.time(),
      ),
    ).toEqual({ vaultId: target.id, kind: "signalsSummary" });
    expect(ledger.resolve(valid.requestId, valid.intentToken)).toBeNull();
    const missing = ledger.reserve({ ...input, vaultId: "missing-synthetic-vault" });
    expect(
      await resolveNotificationIntent(
        ledger,
        f.context.stores,
        { isAdmittedAndUnlocked: () => true },
        missing.requestId,
        missing.intentToken,
        () => f.time(),
      ),
    ).toBeNull();
  } finally {
    await f.close();
  }
});
