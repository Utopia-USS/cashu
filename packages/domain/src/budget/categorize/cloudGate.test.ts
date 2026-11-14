import { describe, expect, it } from "vitest";
import { normalizeText } from "../../text.js";
import { type CloudRow, cloudMerchants, hasIdentifierDigits, hasP2pMarker } from "./cloudGate.js";
import { txnMerchantKey } from "./engine.js";
import {
  bareRow,
  CARD_MERCHANTS,
  ibanRow,
  markerRow,
  P2P_DESCRIPTIONS,
  P2P_TEMPLATES,
  type Rendered,
  render,
} from "./testing/p2pTemplates.js";

const SEEDS = [1, 2, 3, 20261101];
const PER_SEED = 200;

/** Sent strings that equal a P2P row's merchant key or carry one of its names (normalized). */
function leaks(
  sent: readonly string[],
  rendered: readonly Rendered[],
  rows: readonly CloudRow[],
): string[] {
  const keys = new Set(rows.map(txnMerchantKey));
  const names = new Set(
    rendered
      .flatMap((r) => r.names.map((n) => normalizeText(n).replace(/\.$/, "")))
      .filter((n) => n.length >= 3),
  );
  return sent.filter(
    (s) => keys.has(s) || [...names].some((n) => s.split(/[^A-Z0-9]+/).includes(n)),
  );
}

// PRIVACY(D-09.5): the S09 review's 17 templates x inflected names must never reach the cloud.
describe("cloud gate: P2P templates never leak (PRIVACY D-09.5)", () => {
  for (const template of P2P_TEMPLATES) {
    it.each(SEEDS)(
      `${template} (seed %i): with a counterparty IBAN, with a P2P marker, seen once with either`,
      (seed) => {
        const rendered = render(template, seed, PER_SEED);
        const withIban = rendered.map(ibanRow);
        const withMarker = rendered.map((r, i) =>
          markerRow(r, P2P_DESCRIPTIONS[i % P2P_DESCRIPTIONS.length] as string),
        );
        // the same text once as a transfer and once as a plain row: still never eligible
        const seenOnce = rendered.flatMap((r, i) => [
          i % 2 ? ibanRow(r) : markerRow(r, "BLIK P2P"),
          bareRow(r),
        ]);
        for (const rows of [withIban, withMarker, seenOnce]) {
          const sent = cloudMerchants([...rows, ...CARD_MERCHANTS]);
          expect(leaks(sent, rendered, rows)).toEqual([]);
          expect(sent).toEqual([
            "MCDONALDS 1234",
            "SKLEP TESTOWY SP. Z O.O.",
            "ZABKA Z1234 KRAKOW",
          ]);
        }
      },
    );
  }
});

describe("cloud gate pieces", () => {
  it("P2P markers match whole words of the normalized text", () => {
    expect(hasP2pMarker("PRZELEW NA TELEFON 48 123")).toBe(true);
    expect(hasP2pMarker("ZWROT OD JAN")).toBe(true);
    expect(hasP2pMarker("SKLEP TELEFONY KRAKOW")).toBe(false);
    expect(hasP2pMarker("ODZIEZ DLAWIK")).toBe(false);
    expect(hasP2pMarker("ZABKA Z1234")).toBe(false);
  });

  it("only unknown outflows are candidates; an empty IBAN does not taint", () => {
    const base = CARD_MERCHANTS[0] as CloudRow;
    expect(cloudMerchants([{ ...base, source: "keyword" }])).toEqual([]);
    expect(cloudMerchants([{ ...base, counterpartyIban: "  " }])).toEqual(["ZABKA Z1234 KRAKOW"]);
    expect(cloudMerchants([{ ...base, counterpartyIban: "PL61" }])).toEqual([]);
  });
});

// PRIVACY(D-09.5) F2: account, card and phone numbers never reach the cloud.
describe("identifier digits (9+ in a run, separators ignored)", () => {
  it.each([
    ["ZWROT 61109010140000071219812874", true],
    ["PRZELEW 48 123 456 789", true],
    ["(22) 123-45-67 TEST", true],
    ["KARTA 1234/5678/9", true],
    ["SKLEP 12345678", false],
    ["ZABKA Z1234 KRAKOW 5678", false],
    ["DATA 2026-01-01 12345", true], // no date exemption here: fail closed
    ["NR 1234 SKLEP 56789", false],
    ["\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669", true],
  ])("%s -> %s", (text, want) => {
    expect(hasIdentifierDigits(text)).toBe(want);
  });

  it("a merchant key with an account number is not eligible", () => {
    const base = CARD_MERCHANTS[0] as CloudRow;
    expect(cloudMerchants([{ ...base, reference: "ZWROT 61109010140000071219812874" }])).toEqual(
      [],
    );
  });
});
