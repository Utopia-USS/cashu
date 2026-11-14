import { describe, expect, it } from "vitest";
import { validateConnectorDocument } from "./document.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("connector document domain validation", () => {
  it("accepts a synthetic budget document through the canonical importer", () => {
    const result = validateConnectorDocument(
      "budget",
      bytes({
        format: "cashu-budget-import",
        format_version: 1,
        source: "synthetic",
        account: { currency: "PLN" },
        transactions: [
          { booking_date: "2026-01-02", amount: "-1.00", currency: "PLN", reference: "synthetic" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.module === "budget")
      expect(result.statement.transactions[0]?.source).toBe("connector");
  });

  it("refuses malformed budget and investment documents before staging", () => {
    expect(validateConnectorDocument("budget", bytes({ format: "wrong" }))).toEqual({
      ok: false,
      code: "invalid_document",
    });
    expect(validateConnectorDocument("investments", bytes({ format: "wrong" }))).toEqual({
      ok: false,
      code: "invalid_document",
    });
    expect(validateConnectorDocument("budget", new Uint8Array())).toEqual({
      ok: false,
      code: "oversized_document",
    });
  });
});
