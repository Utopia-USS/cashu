// Synthetic events and the actual registry/redaction path shared by S38b tests.
import { D } from "@cashu/domain";
import { importStatement, openAccount } from "@cashu/store";
import { enabledModuleIds } from "@cashu/store/core";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { enabledIn, type ToolContext, validateArguments } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { budgetTools } from "../tools/budget.js";
import { loansTools } from "../tools/loans.js";
import type { nativeFixture } from "./native.js";

export type Fixture = ReturnType<typeof nativeFixture>;
export function callTool(
  ctx: ToolContext<NativeToolStore>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const spec = [...budgetTools(), ...loansTools()].find((tool) => tool.name === name);
  if (!spec) throw new Error("missing synthetic tool");
  if (!enabledIn(spec, enabledModuleIds(ctx.store.read))) throw new Error("tool disabled");
  const values = validateArguments(spec, args);
  const redactor = new Redactor({ privacy: ctx.privacy, guard: ctx.guard });
  const output = redactor.apply(spec.handler(ctx, values));
  leakCheck(output, { strict: ctx.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(output));
}
export function bankAccount(f: Fixture, currency = "PLN", extra: Record<string, unknown> = {}) {
  const out = f.run(openAccount, {
    bank: "mbank",
    name: "Private bank account",
    type: "checking",
    currency,
    ...extra,
  });
  if (!out.ok) throw new Error(out.reason);
  return out.value.account;
}
let sequence = 0;
export function bankTxn(
  f: Fixture,
  account: string,
  opts: {
    date?: string;
    amount: string;
    merchant?: string | null;
    currency?: string;
    iban?: string | null;
    reference?: string | null;
    category?: string;
  },
) {
  sequence += 1;
  const result = f.run(importStatement, {
    account,
    statement: {
      bank: "mbank",
      accountNumber: null,
      accountName: null,
      currency: opts.currency ?? "PLN",
      transactions: [
        {
          bookingDate: opts.date ?? "2026-10-01",
          valueDate: null,
          amount: D(opts.amount),
          currency: opts.currency ?? "PLN",
          counterpartyName: opts.merchant ?? null,
          counterpartyIban: opts.iban ?? null,
          description: null,
          reference: opts.reference ?? null,
          bankTransactionId: `synthetic-${sequence}`,
          source: "csv",
          raw: {},
        },
      ],
      balances: [],
      closingBalances: [],
    },
  });
  if (!result.ok) throw new Error(result.reason);
  const gid = result.events.find((event) => event.type === "txn.imported")?.gid;
  if (gid === undefined) throw new Error("synthetic transaction was not imported");
  if (opts.category !== undefined)
    f.seed("txn.categorySet", { category: opts.category, source: "manual_txn" }, gid);
  return gid;
}
