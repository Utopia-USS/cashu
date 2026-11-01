// The app's decision writes (Python `api.py` decide / position_decide / acknowledge, F9): the checks
// the routes make before `journal.record_decision`, then S22d's `recordDecision` in the same batch.
// A position decision covers several open signals of one instrument with one journal entry; the
// acknowledgements are DERIVED from the links (events.md 6.5), so nothing else is emitted.
import { z } from "zod";
import { type CommandContext, defineCommand, refuse } from "../../command.js";
import { DECISION_ACTIONS } from "../../events/v1/journal.js";
import { decimal, gid } from "../../events/v1/primitives.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentRoot } from "../queries/shared.js";
import { signalByGid } from "../queries/signals.js";
import { brokerageAccount } from "../queries/transactions.js";
import { recordDecision } from "./journal.js";

const OPEN = new Set(["active", "acknowledged"]);

const decisionFields = {
  action: z.enum(DECISION_ACTIONS),
  account: gid.nullable().default(null),
  quantity: decimal.nullable().default(null),
  price: decimal.nullable().default(null),
  currency: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
};

type DecisionFields = {
  action: (typeof DECISION_ACTIONS)[number];
  account: string | null;
  quantity: string | null;
  price: string | null;
  currency: string | null;
  reason: string | null;
};

/** The route's account check: a brokerage account of this vault, or `no_account`. */
function checkAccount(ctx: CommandContext, account: string | null): boolean {
  return account === null || brokerageAccount(ctx.read, account) !== undefined;
}

function record(
  ctx: CommandContext,
  fields: DecisionFields,
  signals: readonly string[],
  instrument: string | null,
) {
  return recordDecision.run(
    ctx,
    recordDecision.input.parse({ ...fields, signals: [...signals], instrument }),
  );
}

export const decideSignal = defineCommand({
  id: "investments.decideSignal",
  input: z.object({ signal: gid, ...decisionFields }),
  /** `POST signals/{id}/decision`: a decision about one signal (acknowledges it; never books a trade). */
  run(ctx, input) {
    if (signalByGid(ctx.read, input.signal) === undefined) return refuse("no_signal");
    if (!checkAccount(ctx, input.account)) return refuse("no_account");
    return record(ctx, input, [input.signal], null);
  },
});

export const decidePosition = defineCommand({
  id: "investments.decidePosition",
  input: z.object({ instrument: gid, signals: z.array(gid).default([]), ...decisionFields }),
  /**
   * `POST positions/{instrument}/decision`: one decision about a position (held or watched) covering
   * its open signals (possibly none), each listed once. Refusals in the route's order: an instrument
   * the vault does not reference (`no_instrument`), an account outside it (`no_account`), then per
   * signal an unknown one (`no_signal`), a closed one (`signal_closed`), one about another instrument
   * or the whole portfolio (`other_instrument`).
   */
  run(ctx, input) {
    const instrument = instrumentRoot(ctx.read, input.instrument);
    if (!vaultInstrumentGids(ctx.read).has(instrument)) return refuse("no_instrument");
    if (!checkAccount(ctx, input.account)) return refuse("no_account");
    const signals: string[] = [];
    for (const g of new Set(input.signals)) {
      const row = signalByGid(ctx.read, g);
      if (row === undefined) return refuse("no_signal");
      if (!OPEN.has(row.status)) return refuse("signal_closed");
      if (row.instrument !== instrument) return refuse("other_instrument");
      signals.push(g);
    }
    return record(ctx, input, signals, instrument);
  },
});

export const acknowledgeSignal = defineCommand({
  id: "investments.acknowledgeSignal",
  input: z.object({ signal: gid, reason: z.string().nullable().default(null) }),
  /** `POST signals/{id}/acknowledge`: seen, no change (a journal entry `held`, reason `acknowledged`). */
  run(ctx, input) {
    const row = signalByGid(ctx.read, input.signal);
    if (row === undefined) return refuse("no_signal");
    if (!OPEN.has(row.status)) return refuse("signal_closed");
    return record(
      ctx,
      {
        action: "held",
        account: null,
        quantity: null,
        price: null,
        currency: null,
        reason: input.reason || "acknowledged",
      },
      [input.signal],
      null,
    );
  },
});
