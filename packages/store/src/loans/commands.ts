// Loans commands (S24 5). Python oracle: `loans/service.py` (set_loan, add_loan,
// set_payment_matching): terms attach only to visible mortgage / loan accounts; payment matching
// changes only the fields given (IBAN normalized, text stripped, empty clears).
import { normalizeIban } from "@cashu/domain";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { decimalInput, ensureAccount, visibleAccount } from "../core/commands.js";
import { liveAccountsNamed, profileOf } from "../core/queries.js";
import { calendarDate, gid } from "../events/v1/primitives.js";
import { loanOfAccount } from "./queries.js";

const LOAN_TYPES = ["mortgage", "loan"];

const terms = {
  principal: decimalInput,
  annualRate: decimalInput,
  termMonths: z.int().min(1),
  startDate: calendarDate,
  originationDate: calendarDate.nullable().optional(),
  paymentIban: z.string().nullable().optional(),
  paymentText: z.string().nullable().optional(),
};
type Terms = z.infer<z.ZodObject<typeof terms>>;

/** Payment matching after an edit: given fields replace (empty clears), absent ones stay. */
function matching(
  ctx: CommandContext,
  account: string,
  iban: string | null | undefined,
  text: string | null | undefined,
): { paymentIban: string | null; paymentText: string | null } | undefined {
  if (iban == null && text == null) return undefined;
  const current = loanOfAccount(ctx.read, account);
  return {
    paymentIban: iban != null ? normalizeIban(iban) || null : (current?.paymentIban ?? null),
    paymentText: text != null ? text.trim() || null : (current?.paymentText ?? null),
  };
}

/** Emit the terms (and the matching when a payment field is given) of the loan on `account`. */
function emitLoan(ctx: CommandContext, account: string, t: Terms): void {
  const loan = ctx.det("loans", [account]);
  ctx.emit("loan.termsSet", loan, {
    account,
    principal: t.principal,
    annualRate: t.annualRate,
    termMonths: t.termMonths,
    startDate: t.startDate,
    originationDate: t.originationDate ?? null,
  });
  const m = matching(ctx, account, t.paymentIban, t.paymentText);
  if (m !== undefined) ctx.emit("loan.paymentMatchingSet", loan, { account, ...m });
}

export const setLoan = defineCommand({
  id: "loans.setLoan",
  input: z.object({ account: gid, ...terms }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined) return refuse("no_account");
    if (!LOAN_TYPES.includes(a.type)) return refuse("not_loan");
    emitLoan(ctx, a.gid, input);
    return ok({ account: a.gid });
  },
});

/**
 * A loan in one step (Python `add_loan`): by `name` (the one visible mortgage / loan account of that
 * name, else a new manual account; a non-loan account holding the name key refuses), or on an
 * existing loan `account`.
 */
export const addLoan = defineCommand({
  id: "loans.addLoan",
  input: z.object({
    name: z.string().min(1).optional(),
    account: gid.optional(),
    type: z.enum(["mortgage", "loan"]).default("loan"),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    ...terms,
  }),
  run(ctx, input) {
    if ((input.name === undefined) === (input.account === undefined))
      return refuse("name_or_account");
    let account: string;
    if (input.account !== undefined) {
      const a = visibleAccount(ctx, input.account);
      if (a === undefined) return refuse("no_account");
      if (!LOAN_TYPES.includes(a.type)) return refuse("not_loan");
      account = a.gid;
    } else {
      const name = input.name as string;
      const named = liveAccountsNamed(ctx.read, name);
      const loanish = named.filter((a) => LOAN_TYPES.includes(a.type));
      if (loanish.length > 1) return refuse("ambiguous");
      const taken = named.find((a) => a.bank === "manual" && a.externalId === `manual:${name}`);
      if (loanish[0] !== undefined) account = loanish[0].gid;
      else if (taken !== undefined) return refuse("name_taken");
      else {
        const base = profileOf(ctx.read)?.baseCurrency ?? "PLN";
        account = ensureAccount(ctx, {
          bank: "manual",
          name,
          externalId: `manual:${name}`,
          type: input.type,
          currency: input.currency ?? base,
        }).gid;
      }
    }
    emitLoan(ctx, account, input);
    return ok({ account });
  },
});

export const setPaymentMatching = defineCommand({
  id: "loans.setPaymentMatching",
  input: z.object({
    account: gid,
    iban: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined || loanOfAccount(ctx.read, a.gid) === undefined) return refuse("no_loan");
    const m = matching(ctx, a.gid, input.iban, input.text);
    if (m !== undefined) {
      ctx.emit("loan.paymentMatchingSet", ctx.det("loans", [a.gid]), { account: a.gid, ...m });
    }
    return ok(null);
  },
});
