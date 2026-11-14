import { type CommandContext, defineCommand, ok } from "@cashu/store";
import { expect, it } from "vitest";
import { z } from "zod";
import { connectorImportCommand } from "./connectorImportCommand.js";
import { bindingParamsDigest, type TransportBinding } from "./connectors/binding.js";
import { manifestSchema } from "./connectors/manifest.js";

const vault = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const account = "01K90000000000000000000000";
const bindingId = "01K90000000000000000000001";
const digest = "a".repeat(64);
const manifest = manifestSchema.parse({
  api_version: 1,
  id: "synthetic-fetch",
  name: "Synthetic",
  version: "1",
  module: "budget",
  kind: "fetch",
  run: ["./run"],
  fetch: { hosts: ["example.test"] },
});

function fixture() {
  let cursor: string | null = null;
  let params = "{}";
  let holder = true;
  let module = "budget";
  let accountType = "checking";
  const events: { type: string; cause?: string }[] = [];
  const binding: TransportBinding = {
    id: bindingId,
    profileId: vault,
    accountId: account,
    connectorId: "synthetic-fetch",
    module: "budget",
    baseCursor: null,
    paramsDigest: bindingParamsDigest({}),
    approvedCodeDigest: digest,
    interpreter: "/synthetic/interpreter",
  };
  const catalog = {
    approved() {
      return { root: "/synthetic", manifest, files: [], contentSha256: digest };
    },
  };
  const ctx = {
    vault,
    lease: { isHolder: () => holder },
    read<R>(sql: string): R[] {
      if (sql.includes("FROM profile_modules")) return [{ module_id: module }] as R[];
      if (sql.includes("FROM connector_bindings"))
        return [
          {
            gid: bindingId,
            connector_id: "synthetic-fetch",
            params_json: params,
            cursor,
            account_gid: account,
          },
        ] as R[];
      if (sql.includes("FROM accounts") && sql.includes("type ="))
        return accountType === "brokerage" ? ([{ gid: account }] as R[]) : [];
      if (sql.includes("FROM accounts"))
        return [
          {
            gid: account,
            bank: "synthetic",
            name: "Synthetic",
            iban: null,
            ibanKey: null,
            externalId: null,
            currency: "PLN",
            type: accountType,
            removed: 0,
          },
        ] as R[];
      return [];
    },
    emit(type: string, _gid: string, _data: Record<string, unknown>, opts?: { cause?: string }) {
      events.push({ type, cause: opts?.cause });
      return `event-${events.length}`;
    },
  } as CommandContext;
  const inner = defineCommand({
    id: "synthetic.zeroRowImport",
    input: z.object({}),
    run(innerCtx) {
      innerCtx.emit("importBatch.recorded", "01K90000000000000000000002", { numInserted: 0 });
      return ok({ inserted: 0 });
    },
  });
  const command = connectorImportCommand({
    command: inner,
    value: {},
    binding,
    newCursor: "next",
    catalog,
    isHolder: () => holder,
  });
  return {
    ctx,
    command,
    events,
    setCursor: (value: string | null) => {
      cursor = value;
    },
    setParams: (value: string) => {
      params = value;
    },
    setHolder: (value: boolean) => {
      holder = value;
    },
    setModule: (value: string) => {
      module = value;
    },
    setAccountType: (value: string) => {
      accountType = value;
    },
  };
}

it("causes a cursor from a successful zero-row import batch", () => {
  const f = fixture();
  expect(f.command.run(f.ctx, {})).toEqual({ ok: true, value: { inserted: 0 } });
  expect(f.events).toEqual([
    { type: "importBatch.recorded", cause: undefined },
    { type: "connectorBinding.cursorAdvanced", cause: "event-1" },
  ]);
});

it("refuses stale cursor, changed params, lost holder, disabled module and changed account type", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setCursor("other"),
    (f: ReturnType<typeof fixture>) => f.setParams('{"changed":true}'),
    (f: ReturnType<typeof fixture>) => f.setHolder(false),
    (f: ReturnType<typeof fixture>) => f.setModule("investments"),
    (f: ReturnType<typeof fixture>) => f.setAccountType("brokerage"),
  ]) {
    const f = fixture();
    change(f);
    expect(f.command.run(f.ctx, {})).toEqual({ ok: false, reason: "connector_binding_changed" });
    expect(f.events).toEqual([]);
  }
});
