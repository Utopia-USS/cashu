import { describe, expect, it } from "vitest";
import { claimAllowed, ibanKeyLoose, isValidIban } from "./identity.js";

describe("IBAN identity keys (N2)", () => {
  it("accepts valid IBANs (ISO 13616 documentation examples) and bare Polish NRBs", () => {
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("PL61 1090 1014 0000 0712 1981 2874")).toBe(true);
    expect(isValidIban("'61109010140000071219812874")).toBe(true); // CSV form with Excel guard
  });

  it("rejects a wrong check digit, masked, short or malformed numbers", () => {
    expect(isValidIban("PL61 1090 1014 0000 0712 1981 2875")).toBe(false);
    expect(isValidIban("PL61 1090 **** **** **** 1981 2874")).toBe(false);
    expect(isValidIban("6110901014")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban(null)).toBe(false);
  });

  it("claims an iban key only with a valid IBAN of the same key in the event", () => {
    const iban = "PL61109010140000071219812874";
    expect(ibanKeyLoose(iban)).toBe("61109010140000071219812874");
    expect(claimAllowed("iban:61109010140000071219812874", iban)).toBe(true);
    expect(claimAllowed("iban:61109010140000071219812874", "61109010140000071219812874")).toBe(
      true,
    );
    expect(claimAllowed("iban:61109010140000071219812874", null)).toBe(false);
    expect(claimAllowed("iban:00000000000000000000000000", iban)).toBe(false);
    expect(claimAllowed("ext:mbank:eb:uid-1", undefined)).toBe(true);
  });
});
