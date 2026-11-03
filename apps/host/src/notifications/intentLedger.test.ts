import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { privateNotificationIntents } from "./intentLedger.js";
import { hostNotifier } from "./notifier.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-notification-intents-"));
  dirs.push(dir);
  let now = 1_700_000_000_000;
  const ledger = privateNotificationIntents(
    dir,
    () => true,
    () => now,
  );
  return {
    dir,
    ledger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const request = {
  vaultId: "synthetic-vault",
  kind: "signal" as const,
  signalId: "synthetic-signal",
  locale: "pl" as const,
};

it("stores a bounded opaque intent in a private durable file and consumes once", () => {
  const { dir, ledger } = fixture();
  const first = ledger.reserve(request);
  expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.intentToken).toMatch(/^[0-9a-f]{64}$/);
  const bytes = readFileSync(join(dir, "notification-intents.json"), "utf8");
  expect(bytes).toContain(first.intentToken);
  expect(bytes).not.toContain("merchant");
  expect(ledger.resolve(first.requestId, first.intentToken)).toEqual(first);
  expect(ledger.resolve(first.requestId, "0".repeat(64))).toBeNull();
  expect(ledger.consume(first.requestId, first.intentToken)).toBe(true);
  expect(ledger.consume(first.requestId, first.intentToken)).toBe(false);
  expect(ledger.resolve(first.requestId, first.intentToken)).toBeNull();
});

it("expires intents and refuses a corrupt or symlinked ledger", () => {
  const { dir, ledger, advance } = fixture();
  const intent = ledger.reserve(request);
  advance(7 * 24 * 60 * 60 * 1000);
  expect(ledger.resolve(intent.requestId, intent.intentToken)).toBeNull();
  const path = join(dir, "notification-intents.json");
  writeFileSync(path, "broken");
  expect(() => ledger.reserve(request)).toThrow("notification_intents_unavailable");
  rmSync(path);
  symlinkSync(join(dir, "elsewhere"), path);
  expect(() => ledger.reserve(request)).toThrow("notification_intents_unavailable");
});

it("never retries uncertain transport and revokes only proven pre-submission rejection", async () => {
  const { ledger } = fixture();
  let captured: { requestId: string; intentToken: string } | undefined;
  const accepted = hostNotifier(ledger, {
    submit: async (frame) => {
      captured = frame;
      throw new Error("lost acknowledgement");
    },
  });
  expect(await accepted.send(request)).toEqual({ state: "unknown" });
  if (captured === undefined) throw new Error("missing frame");
  expect(ledger.resolve(captured.requestId, captured.intentToken)).not.toBeNull();
  const rejected = hostNotifier(ledger, {
    submit: async (frame) => {
      captured = frame;
      return { state: "rejected", reason: "denied" };
    },
  });
  expect(await rejected.send(request)).toEqual({ state: "rejected", reason: "denied" });
  expect(ledger.resolve(captured.requestId, captured.intentToken)).toBeNull();
});
