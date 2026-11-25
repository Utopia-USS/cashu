// Strict-mode privacy of custom rule expressions and owner labels: amount literals in conditions and
// signal messages, owner-named prices, and display-name aliases (with digits) swapped before the agent
// sees them. Tool-level flows are covered in the tools tests.
import { describe, expect, it } from "vitest";
import { scrubAmountLiterals } from "./exprLiterals.js";
import { text } from "./labels.js";
import { customCondition, customSignalMessage } from "./messages.js";
import { NameGuard } from "./names.js";
import { pyDumps } from "./pyJson.js";
import { Redactor } from "./redactor.js";
import { scrubText } from "./scrub.js";

const BUFFER = "cash_value > 7 and cash_weight < 99%";
const STRICT = { strict: true };
const AMOUNTS = { strict: false };

describe("test_amount_literals", () => {
  const cases: [string, string | null][] = [
    ["cash_value > 735", "cash_value > [amount]"],
    ["weight < 0.03 and value > 800", "weight < 0.03 and value > [amount]"],
    ["drawdown_from_high(252) >= 20% and weight < 3%", null],
    ["days_since_last_deposit > 45", null],
    ["last_close > 120", null], // a public price level
    ["cash_value / total_value > 0.1", "cash_value / total_value > [amount]"], // conservative
    ["total_value - cash_value < -50", "total_value - cash_value < -[amount]"],
    ["cash_value >", "cash_value >"], // does not parse: bare numbers only, none here
    ["broken ( 500 and 5%", "broken ( [amount] and 5%"],
    // F7 review R7: a literal scaled into an amount
    ["last_close * 40 > 5000", "last_close * [amount] > [amount]"],
    ["weight * 120000 > 900", "weight * [amount] > [amount]"],
    ["last_close + 15 > 120", "last_close + [amount] > [amount]"],
    ["40 * last_close > 5000", "[amount] * last_close > [amount]"],
    ["weight * 100 > 5", null], // a percent conversion keeps the ratio
    ["drawdown_from_high(252) / 2 > 0.1", "drawdown_from_high(252) / [amount] > [amount]"],
    // F7 re-review B4: a literal fraction on the other side
    ["weight > 900 / 120000", "weight > [amount] / [amount]"],
    ["last_close > 5000 / 40", "last_close > [amount] / [amount]"],
    ["weight > 5 * 0.01", "weight > [amount] * [amount]"], // conservative
    ["weight > 5% / 100", null], // a percent and 1 / 100 stay
    ["weight > 1 / 100", null],
  ];
  it.each(cases)("%s", (source, expected) => {
    expect(scrubAmountLiterals(source)).toBe(expected ?? source);
  });
});

it("test_owner_named_prices_are_amounts", () => {
  expect(scrubAmountLiterals("last_close > 120", undefined, { privatePrices: true })).toBe(
    "last_close > [amount]",
  );
});

describe("test_strict_mode_scrubs_amount_literals_of_custom_alerts (privacy step; tool flow: S38)", () => {
  it("scrubs the alert expression and the signal condition in strict, keeps them in amounts", () => {
    const redactor = new Redactor({ privacy: "strict" });
    const expression = redactor.apply({ expression: customCondition(STRICT, BUFFER) });
    expect(expression).toEqual({ expression: "cash_value > [amount] and cash_weight < 99%" });
    const message = `idle cash: Warunek spełniony: ${BUFFER} (cash_value 7 312,00 zł; cash_weight 12,3 %).`;
    const sent = redactor.apply({
      message: customSignalMessage(STRICT, message, BUFFER),
    }) as {
      message: string;
    };
    expect(sent.message).toContain("cash_value > [amount] and cash_weight < 99%");
    expect(sent.message).not.toContain("> 7");
    expect(pyDumps(sent)).not.toContain("7 312");

    const full = new Redactor({ privacy: "amounts" });
    expect(full.apply({ expression: customCondition(AMOUNTS, BUFFER) })).toEqual({
      expression: BUFFER,
    });
    expect(
      (
        full.apply({ message: customSignalMessage(AMOUNTS, message, BUFFER) }) as {
          message: string;
        }
      ).message,
    ).toContain(BUFFER);
  });
});

const LABEL = "Na mieszkanie dla Tomka Lis";

describe("test_display_name_override_never_reaches_the_agent_in_strict_mode (privacy step; tool flow: S38)", () => {
  const guard = new NameGuard({ profileId: 1, strictAliases: [[LABEL, "PKO Bank Polski"]] });
  it("swaps the owner's label in every strict text and keeps it in amounts", () => {
    const tree = {
      name: text(guard.publicName(LABEL)),
      message: text(`PKO above 10: ${LABEL} zamknięcie 11,2 PLN.`),
    };
    const strict = pyDumps(new Redactor({ privacy: "strict", guard }).apply(tree));
    expect(strict).not.toContain("Tomka");
    expect(strict).not.toContain("mieszkanie");
    expect(strict).toContain("PKO Bank Polski");
    const amounts = pyDumps(
      new Redactor({ privacy: "amounts", guard }).apply({ name: text(LABEL) }),
    );
    expect(amounts).toContain(LABEL); // amounts mode: the owner's own label
  });
});

// F7 review R6: labels with a number (a goal year, a target amount) must be swapped too; the strict
// number scrub used to rewrite them before the alias swap looked for the owner's label.
const DIGIT_LABELS = [
  "Wesele 45000 Kasi",
  "IKE Oli 2030",
  "Mieszkanie 300 000 Oli",
  "Studia Ani 1 200 zł",
  "Cel 50k Tomek",
];

describe("test_scrub_text_swaps_aliases_with_numbers_before_the_number_scrub", () => {
  it.each(DIGIT_LABELS)("%s", (label) => {
    const guard = new NameGuard({ profileId: 1, strictAliases: [[label, "Public Market Name"]] });
    const out = scrubText(`Pozycja ${label} spadła o 5%`, { strict: true, guard });
    expect(out).toBe("Pozycja Public Market Name spadła o 5%");
    expect(guard.publicName(`  ${label.toUpperCase()} `)).toBe("Public Market Name");
    expect(guard.publicName("Inna nazwa")).toBe("Inna nazwa");
    // amounts mode keeps the owner's label
    expect(scrubText(`Pozycja ${label}`, { strict: false, guard })).toContain(label);
  });
});

describe("test_digit_label_override_never_reaches_the_agent_in_strict_mode (privacy step; tool flow: S38)", () => {
  it.each(["Wesele 45000 Kasi", "IKE Oli 2030"])("%s", (label) => {
    const guard = new NameGuard({ profileId: 1, strictAliases: [[label, "PKO Bank Polski"]] });
    const words = label.split(" ");
    const person = (label.startsWith("IKE") ? words[1] : words[words.length - 1]) as string;
    const purpose = words[0] as string;
    const tree = {
      positions: [{ symbol: text("PKO"), name: text(guard.publicName(label)) }],
      message: text(`${label}: cena powyżej 10 PLN`),
    };
    const out = pyDumps(new Redactor({ privacy: "strict", guard }).apply(tree));
    expect(out).not.toContain(person);
    expect(out).not.toContain(purpose);
    expect(out).toContain('"name": "PKO Bank Polski"');
  });
});
