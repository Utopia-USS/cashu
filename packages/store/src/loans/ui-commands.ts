/** Closed dashboard writes matching loans/api.py, separate from CLI upserts. */
import { D, normalizeIban, normalizeText, pySplit, pyStrip, pyUpper } from "@cashu/domain";
import { z } from "zod";
import { defineCommand, refuse } from "../command.js";
import { decimalInput } from "../core/commands.js";
import { liveAccountsNamed, profileOf } from "../core/queries.js";
import { calendarDate, gid } from "../events/v1/primitives.js";
import { addLoan, setPaymentMatching } from "./commands.js";

export const createUiLoan = defineCommand({
  id: "loans.createUiLoan",
  input: z.object({
    name: z.string(),
    type: z.enum(["mortgage", "loan"]).default("mortgage"),
    principal: decimalInput,
    annualRate: decimalInput,
    termMonths: z.int().min(1).max(600),
    startDate: calendarDate,
    originationDate: calendarDate.nullable().optional(),
    currency: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    const name = pySplit(input.name).join(" ");
    const currency = pyUpper(pyStrip(input.currency || profileOf(ctx.read)?.baseCurrency || "PLN"));
    if (!name || Array.from(name).length > 120 || !/^[A-Z]{3}$/u.test(currency))
      return refuse("loan_invalid");
    if (
      D(input.principal).lte(D("0")) ||
      D(input.annualRate).lt(D("0")) ||
      D(input.annualRate).gt(D("100")) ||
      (input.originationDate != null && input.originationDate > input.startDate)
    )
      return refuse("loan_invalid");
    if (liveAccountsNamed(ctx.read, name).some((a) => a.type === "loan" || a.type === "mortgage"))
      return refuse("loan_name_taken");
    return addLoan.run(ctx, { ...input, name, currency });
  },
});

export const setUiLoanPayment = defineCommand({
  id: "loans.setUiLoanPayment",
  input: z.object({
    account: gid,
    text: z.string().nullable().optional(),
    iban: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    if (input.text === undefined && input.iban === undefined) return refuse("loan_invalid");
    const text = input.text === undefined ? undefined : pyStrip(input.text ?? "");
    const iban = input.iban === undefined ? undefined : (input.iban ?? "");
    if (
      text !== undefined &&
      (Array.from(pyStrip(text)).length > 200 || (pyStrip(text) !== "" && !normalizeText(text)))
    )
      return refuse("loan_invalid");
    const normalized = normalizeIban(iban ?? "");
    if (iban !== undefined && pyStrip(iban) && (normalized.length < 8 || normalized.length > 34))
      return refuse("loan_invalid");
    return setPaymentMatching.run(ctx, {
      account: input.account,
      ...(text === undefined ? {} : { text }),
      ...(iban === undefined ? {} : { iban }),
    });
  },
});
