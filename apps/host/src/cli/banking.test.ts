import { createTranslator } from "@cashu/i18n";
import { expect, it, vi } from "vitest";
import type { OpenVault } from "../stores.js";
import { bankingCommands } from "./banking.js";
import type { CommandIo } from "./tree.js";

const vault = {
  id: "a".repeat(32),
  mode: "native",
  native: { isCurrent: () => true },
  store: {
    read: (sql: string) =>
      sql.includes("FROM profiles")
        ? [{ slug: "synthetic", name: "Synthetic", baseCurrency: "PLN", mcpPrivacy: "strict" }]
        : [],
  },
} as unknown as OpenVault;
function io() {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const value: CommandIo = {
    cwd: "/private/tmp",
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout,
    stderr,
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { value, stdout, stderr };
}

it("routes profile-scoped native EB reads while hiding pending consent URLs", async () => {
  const perform = vi.fn(async () => ({
    ok: true as const,
    value: {
      configured: true,
      sessions: [],
      pendingConsent: "https://synthetic-bank.example/secret-state",
      pendingAttempts: [],
    },
  }));
  const command = bankingCommands({ vaults: new Map([[vault.id, vault]]), perform })[0];
  const out = io();
  expect(await command?.run(["status", "--json"], out.value, { profile: "synthetic" })).toBe(0);
  expect(perform).toHaveBeenCalledWith(vault, { type: "status" }, out.value.signal);
  expect(out.stdout.mock.calls[0]?.[0]).toContain('"configured":true');
  expect(out.stdout.mock.calls[0]?.[0]).not.toContain("secret-state");
  expect(await command?.run(["status"], out.value, { profile: "other" })).toBe(2);
  expect(perform).toHaveBeenCalledTimes(1);
});

it("keeps private setup and consent in Settings and reports uncertain sync", async () => {
  const perform = vi.fn(async () => ({ ok: false as const, error: "outcome_unknown" }));
  const command = bankingCommands({ vaults: new Map([[vault.id, vault]]), perform })[0];
  const out = io();
  expect(await command?.run(["login", "Synthetic Bank"], out.value, { profile: "synthetic" })).toBe(
    69,
  );
  expect(perform).not.toHaveBeenCalled();
  expect(await command?.run(["resync", "--days", "90"], out.value, { profile: "synthetic" })).toBe(
    1,
  );
  expect(perform).toHaveBeenCalledWith(vault, { type: "sync", days: 90 }, out.value.signal);
  expect(out.stderr.mock.calls.at(-1)?.[0]).toContain("outcome is unknown");
});
