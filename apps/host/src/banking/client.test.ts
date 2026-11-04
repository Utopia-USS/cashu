import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  type BankingTransport,
  EnableBankingClient,
  productionBankingTransport,
} from "./client.js";
import { pickBalance, transactionToRaw } from "./normalize.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const clock = { now: () => new Date("2026-11-04T00:00:00.000Z") };

it("signs short-lived JWTs and follows bounded continuation pages without leaking authorization", async () => {
  const calls: URL[] = [];
  const transport: BankingTransport = {
    async send(input) {
      calls.push(input.url);
      const jwt = input.headers.Authorization?.split(" ")[1];
      if (!jwt) throw new Error("missing jwt");
      const part = jwt.split(".")[1];
      if (!part) throw new Error("missing claims");
      const claim = JSON.parse(Buffer.from(part, "base64url").toString());
      expect(claim).toEqual({
        iss: "enablebanking.com",
        aud: "api.enablebanking.com",
        iat: 1793750400,
        exp: 1793754000,
      });
      return {
        status: 200,
        text: JSON.stringify({
          transactions: [{ entry_reference: `page${calls.length}` }],
          ...(calls.length === 1 ? { continuation_key: "next" } : {}),
        }),
      };
    },
  };
  const client = new EnableBankingClient(
    { appId: "synthetic-app", privateKeyPem: key },
    transport,
    clock,
  );
  const rows = await client.transactions("synthetic-uid", "2026-08-01", "2026-11-04");
  expect(rows).toHaveLength(2);
  expect(calls[1]?.searchParams.get("continuation_key")).toBe("next");
  expect(calls.every((url) => url.origin === "https://api.enablebanking.com")).toBe(true);
  expect(() => client.session("../escape")).toThrow("enable_banking_response");
});

it("rejects repeated cursors and classifies rate limiting without bank response text", async () => {
  const repeating = new EnableBankingClient(
    { appId: "synthetic-app", privateKeyPem: key },
    {
      send: async () => ({
        status: 200,
        text: JSON.stringify({ transactions: [], continuation_key: "again" }),
      }),
    },
    clock,
  );
  await expect(repeating.transactions("uid", "2026-08-01", "2026-11-04")).rejects.toThrow(
    "enable_banking_response",
  );
  const limited = new EnableBankingClient(
    { appId: "synthetic-app", privateKeyPem: key },
    { send: async () => ({ status: 429, text: "private response" }) },
    clock,
  );
  await expect(limited.session("id")).rejects.toThrow("enable_banking_rate_limited");
});

it("keeps exact decimals and human titles, selects the preferred balance", () => {
  const row = transactionToRaw({
    transaction_amount: { amount: "12.340", currency: "PLN" },
    credit_debit_indicator: "DBIT",
    booking_date: "2026-11-04",
    remittance_information: ["Synthetic", "purchase"],
    entry_reference: "opaque-id",
    creditor_account: { iban: "PL00000000000000000000000000" },
  });
  expect(row?.amount.toString()).toBe("-12.340");
  expect(row?.reference).toBe("Synthetic purchase");
  expect(row?.bankTransactionId).toBe("opaque-id");
  expect(
    transactionToRaw({ transaction_amount: { amount: 12.34 }, booking_date: "2026-11-04" }),
  ).toBeNull();
  expect(
    pickBalance([{ balance_amount: { amount: 12.34, currency: "PLN" } }], "2026-11-04", "PLN"),
  ).toBeNull();
  expect(
    pickBalance(
      [
        { balance_type: "ITAV", balance_amount: { amount: "10.10", currency: "PLN" } },
        {
          balance_type: "CLBD",
          balance_amount: { amount: "11.230", currency: "PLN" },
          reference_date: "2026-11-04",
        },
      ],
      "2026-11-04",
      "PLN",
    )?.amount.toString(),
  ).toBe("11.230");
});

it("bounds production response bytes while streaming, before JSON allocation", async () => {
  const prior = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  try {
    await expect(
      productionBankingTransport.send({
        method: "GET",
        url: new URL("https://api.enablebanking.com/application"),
        headers: {},
      }),
    ).rejects.toThrow("enable_banking_response");
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = prior;
  }
});
