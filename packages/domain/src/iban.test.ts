import { describe, expect, it } from "vitest";
import { ibanKey, normalizeIban } from "./iban.js";

// Internal transfers are matched by counterparty IBAN only: iban_key must equate the forms banks export.
describe("IBAN keys", () => {
  it("normalize keeps ASCII letters and digits, upper-cased", () => {
    expect(normalizeIban("PL61 1090 1014 0000 0712 1981 2874")).toBe(
      "PL61109010140000071219812874",
    );
    expect(normalizeIban(" pl 61\t")).toBe("PL61");
    expect(normalizeIban("PL61​1090")).toBe("PL611090");
    expect(normalizeIban("ß1234")).toBe("1234");
    expect(normalizeIban(null)).toBe("");
  });

  it("the key of a PL IBAN equals the bare 26-digit number of a Polish CSV export", () => {
    expect(ibanKey("PL61 1090 1014 0000 0712 1981 2874")).toBe("61109010140000071219812874");
    expect(ibanKey("'61109010140000071219812874")).toBe("61109010140000071219812874");
    expect(ibanKey("--")).toBe("");
    expect(ibanKey(undefined)).toBe("");
  });
});
