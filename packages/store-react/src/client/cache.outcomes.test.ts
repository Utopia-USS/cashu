import { renameProfile } from "@cashu/store";
import { expect, it } from "vitest";
import { QueryCache } from "./cache.js";
import type { Adapter, CommandAttempt } from "./types.js";

it("normalizes a rejecting adapter after dispatch to unknown with its original key", async () => {
  let dispatched: CommandAttempt | undefined;
  const adapter: Adapter = {
    vaults: [],
    open() {
      return () => {};
    },
    async run(_target, _command, _input, attempt) {
      dispatched = attempt;
      throw new Error("synthetic transport loss after effect");
    },
  };
  const client = new QueryCache(adapter, {
    async: true,
    mintKey: () => "01JBQX8Z5W3N4R6T7V8Y9A0BCD",
  });
  const outcome = await client.run({ kind: "vault", vault: "a".repeat(32) }, renameProfile, {
    name: "Synthetic",
  });
  expect(outcome.kind).toBe("outcome_unknown");
  if (outcome.kind !== "outcome_unknown") throw new Error("missing unknown outcome");
  expect(outcome.key).toBe(dispatched?.key);
  expect(outcome.attempt).toBe(dispatched);
  client.dispose();
});

it("keeps an unresolved attempt unknown when reconciliation is unavailable", async () => {
  const adapter: Adapter = {
    vaults: [],
    open() {
      return () => {};
    },
    async run(_target, _command, _input, attempt) {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    },
  };
  const client = new QueryCache(adapter, { async: false });
  const target = { kind: "vault" as const, vault: "a".repeat(32) };
  const outcome = await client.run(target, renameProfile, { name: "Synthetic" });
  if (outcome.kind !== "outcome_unknown") throw new Error("missing attempt");
  expect(await client.reconcile(outcome.attempt)).toEqual(outcome);
  client.dispose();
});

it("keeps an unresolved attempt unknown when reconciliation fails", async () => {
  const adapter: Adapter = {
    vaults: [],
    open() {
      return () => {};
    },
    async run(_target, _command, _input, attempt) {
      return { kind: "outcome_unknown", key: attempt.key, attempt };
    },
    async reconcile() {
      throw new Error("synthetic ledger unavailable");
    },
  };
  const client = new QueryCache(adapter, { async: false });
  const outcome = await client.run({ kind: "vault", vault: "a".repeat(32) }, renameProfile, {
    name: "Synthetic",
  });
  if (outcome.kind !== "outcome_unknown") throw new Error("missing attempt");
  expect(await client.reconcile(outcome.attempt)).toEqual(outcome);
  client.dispose();
});
