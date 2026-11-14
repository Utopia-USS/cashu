/// <reference types="node" />
// The frozen expectations of the synthetic native demo. global-setup.ts has the seed script
// (apps/host/src/testing/seedOverviewDemo.ts) write them once: the TS store's results for the seed,
// checked there against the generator's own facts. Specs compare the rendered screens with them.
import { readFileSync } from "node:fs";
import { D } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { z } from "zod";

export const DEMO_EXPECTATIONS_FILE = "demo-expectations.json";

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/u);
const shape = z.object({
  today: z.string(),
  anna: z.object({
    net: decimal,
    currency: z.string(),
    currencies: z.array(z.string()),
    months: z.record(
      z.string(),
      z.object({ currency: z.string(), income: decimal, spending: decimal, surplus: decimal }),
    ),
    accounts: z.array(
      z.object({
        type: z.string(),
        bank: z.string(),
        amount: decimal.nullable(),
        currency: z.string(),
      }),
    ),
    assets: z.array(
      z.object({ kind: z.string(), amount: decimal.nullable(), currency: z.string() }),
    ),
    loans: z.array(
      z.object({
        name: z.string(),
        currency: z.string(),
        outstanding: decimal,
        monthlyPayment: decimal,
      }),
    ),
    investments: z.object({ value: decimal, currency: z.string() }),
    portfolio: z.object({ total: decimal, currency: z.string(), firstLabel: z.string().min(1) }),
    seriesEnd: z.object({ value: decimal, currency: z.string() }),
  }),
  piotr: z.object({ net: decimal, currency: z.string() }),
});

export type DemoExpectations = z.infer<typeof shape>;

/** The calendar day in the shell's time zone (electron-test.ts launches it on Warsaw time). */
export function warsawToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
}

/** The seed's expectations; refuses once the day the seed belongs to has passed. */
export function demoExpectations(): DemoExpectations {
  const file = process.env.E2E_DEMO_EXPECTATIONS;
  if (!file) throw new Error("the synthetic demo expectations are absent (global setup)");
  const expected = shape.parse(JSON.parse(readFileSync(file, "utf8")));
  if (expected.today !== warsawToday())
    throw new Error("the synthetic demo was seeded on another day: run the suite again");
  return expected;
}

/** A decimal as the shell shows it (`amount` decimal text). */
export function rendered(amount: string, currency: string, locale = "pl-PL"): string {
  return formatDecimalValue(D(amount), locale, { currency }).text;
}

/** A decimal as the screens ported from the Python app show it (old `cur`: grouping always, so "2 995,32 zł"). */
export function renderedGrouped(amount: string, currency: string, locale = "pl-PL"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    useGrouping: "always",
  } as Intl.NumberFormatOptions).format(Number(amount));
}

/** `-amount` as decimal text. */
export function negate(amount: string): string {
  return D(amount).neg().toString();
}

/** `amount + delta` as decimal text. */
export function plus(amount: string, delta: string): string {
  return D(amount).add(D(delta)).toString();
}
