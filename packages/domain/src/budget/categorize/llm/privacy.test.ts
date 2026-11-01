/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { looksLikePerson } from "../../../core/index.js";
import { createCategorizer } from "../effective.js";
import { txnMerchantKey } from "../engine.js";
import { unknownMerchants } from "../llmPass.js";
import { AUTO_CATEGORY_KEYS } from "../taxonomy.js";
import { EMPTY_CONTEXT } from "../testing/engineRows.js";
import { row } from "../testing/rows.js";
import { ANTHROPIC_MERCHANT_PREFIX } from "./prompts.js";
import { anthropicMerchantBatches } from "./requests.js";

const IBAN = "PL61 1090 1014 0000 0712 1981 2874";
const AMOUNT = "-4321.98";
const DATE = "2026-04-17";
const PERSON = "Jan Testowy";

describe("privacy guards (CLAUDE.md rule 3)", () => {
  it("the Anthropic body carries ids and merchant keys only", () => {
    const rows = [
      row({
        amount: AMOUNT,
        date: DATE,
        iban: IBAN,
        reference: "SKLEP UNIKAT 77",
        description: "opis",
      }),
      row({ amount: AMOUNT, date: DATE, iban: IBAN, cp: PERSON, reference: "przelew" }),
    ];
    const c = createCategorizer(EMPTY_CONTEXT);
    const unknown = unknownMerchants(
      rows.map((r) => ({
        amount: r.amount,
        merchantKey: txnMerchantKey(r),
        source: c.effective(r, new Set())?.source ?? null,
      })),
    );
    const batches = anthropicMerchantBatches(unknown, AUTO_CATEGORY_KEYS);
    const text = JSON.stringify(batches);
    for (const secret of [
      IBAN,
      IBAN.replaceAll(" ", ""),
      "4321.98",
      "4321",
      DATE,
      PERSON,
      PERSON.toUpperCase(),
      "opis",
    ]) {
      expect(text.includes(secret), secret).toBe(false);
    }
    const [batch] = batches;
    expect(batch && "body" in batch).toBe(true);
    const content =
      (batch as { body: { messages: { content: string }[] } }).body.messages[0]?.content ?? "";
    expect(content.startsWith(ANTHROPIC_MERCHANT_PREFIX)).toBe(true);
    const items = JSON.parse(content.slice(ANTHROPIC_MERCHANT_PREFIX.length)) as Record<
      string,
      string
    >[];
    expect(items).toEqual([{ id: "m0", merchant: "SKLEP UNIKAT 77" }]);
  });

  // FIX(Q12): merchant_key takes the counterparty name first, so a transfer to a person used to send the name.
  it("a person-like merchant never reaches an Anthropic batch (FIX Q12)", () => {
    const merchants = ["JAN TESTOWY", "ANNA PROBNA", "BIEDRONKA 123", "SKLEP TEST SP. Z O.O."];
    expect(merchants.map((m) => looksLikePerson(m))).toEqual([true, true, false, false]);
    const sent = anthropicMerchantBatches(merchants, AUTO_CATEGORY_KEYS).flatMap((b) =>
      "ids" in b ? [...b.ids.values()] : [],
    );
    expect(sent).toEqual(["BIEDRONKA 123", "SKLEP TEST SP. Z O.O."]);
    expect(anthropicMerchantBatches(["JAN TESTOWY"], AUTO_CATEGORY_KEYS)).toEqual([]);
  });

  it("a lone surrogate refuses its batch value-free", () => {
    expect(anthropicMerchantBatches(["A\ud800B"], AUTO_CATEGORY_KEYS)).toEqual([
      { ok: false, reason: "malformed" },
    ]);
  });

  it("no network, clock, randomness or zod in the categorization domain", () => {
    const dir = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("testing"),
    );
    expect(files.length).toBeGreaterThan(10);
    const banned =
      /node:|Math\.random|Date\.now|from "zod"|fetch\(|XMLHttpRequest|WebSocket|from "(?:node:)?https?"/;
    const hits = files.filter((f) => banned.test(readFileSync(`${dir}/${f}`, "utf8")));
    expect(hits).toEqual([]);
  });
});
