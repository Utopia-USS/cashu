// Budget settings (settings.py parse / load, the account check of PUT /budget/settings): translates
// test_settings_validation, test_cushion_accounts_of_another_profile_are_refused and the corrupt-file
// half of test_settings_default_off_and_stored_privately (tests/test_month_close.py), then pins the
// parse rules Python applies to the stored file. Synthetic data only.

import { describe, expect, it } from "vitest";
import {
  type CushionSettings,
  checkCushionAccounts,
  cushionAccountsError,
  defaultBudgetSettings,
  loadBudgetSettings,
  parseBudgetSettings,
} from "./settings.js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const MAIN = { id: "7", name: "mKonto Test", currency: "PLN" };
const EUR = { id: "8", name: "eKonto EUR Test", currency: "EUR" };

function cushionOf(raw: unknown): CushionSettings<number> {
  const parsed = parseBudgetSettings(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.settings.cushion;
}

function asIds(c: CushionSettings<number>): CushionSettings {
  return { ...c, accountIds: c.accountIds.map(String) };
}

describe("settings.parse", () => {
  it("test_settings_validation (the parse messages)", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ enabled: true }, "an enabled cushion needs target_amount or target_months"],
      [{ enabled: "yes", target_amount: 1 }, "cushion.enabled must be true or false"],
      [{ enabled: true, target_amount: -5 }, "cushion.target_amount must be a positive number"],
      [{ enabled: true, target_amount: "abc" }, "cushion.target_amount must be a positive number"],
      [
        { enabled: true, target_months: 0 },
        "cushion.target_months must be a whole number from 1 to 36",
      ],
      [
        { enabled: true, target_months: 2.5 },
        "cushion.target_months must be a whole number from 1 to 36",
      ],
      [
        { enabled: true, target_amount: 1, currency: "EURO" },
        "cushion.currency must be a three-letter currency code",
      ],
      [
        { enabled: true, target_amount: 1, account_ids: ["x"] },
        "cushion.account_ids must be a list of account ids",
      ],
    ];
    for (const [cushion, detail] of cases) {
      expect(parseBudgetSettings({ cushion }), JSON.stringify(cushion)).toEqual({
        ok: false,
        error: detail,
      });
    }
  });

  it("test_settings_validation (the account checks against the profile's accounts)", () => {
    const unknown = asIds(
      cushionOf({ cushion: { enabled: true, target_amount: 1, account_ids: [999999] } }),
    );
    expect(cushionAccountsError(unknown, [MAIN, EUR], "PLN")).toBe("unknown account id(s): 999999");
    const wrong = asIds(
      cushionOf({
        cushion: { enabled: true, target_amount: 1, currency: "EUR", account_ids: [7] },
      }),
    );
    expect(cushionAccountsError(wrong, [MAIN, EUR], "PLN")).toBe(
      "cushion accounts must be in EUR: mKonto Test",
    );
    const fine = asIds(
      cushionOf({ cushion: { enabled: true, target_amount: 1, account_ids: [7] } }),
    );
    expect(cushionAccountsError(fine, [MAIN, EUR], "PLN")).toBeNull();
    expect(cushionAccountsError(defaultBudgetSettings().cushion, [], "PLN")).toBeNull();
  });

  it("checkCushionAccounts: the typed result behind the message", () => {
    const base = asIds(cushionOf({ cushion: { enabled: true, target_amount: 1 } }));
    const pick = (ids: string[], currency: string | null = null) => ({
      ...base,
      currency,
      accountIds: ids,
    });
    expect(checkCushionAccounts(pick(["7", "99", "98"], "EUR"), [MAIN], "PLN")).toEqual({
      kind: "unknown_account",
      ids: ["99", "98"],
    });
    expect(checkCushionAccounts(pick(["7", "8"], "EUR"), [MAIN, EUR], "PLN")).toEqual({
      kind: "wrong_currency",
      currency: "EUR",
      names: ["mKonto Test"],
    });
    expect(checkCushionAccounts(pick(["8"]), [MAIN, EUR], "EUR")).toBeNull();
    expect(checkCushionAccounts(pick([]), [], "PLN")).toBeNull();
  });

  it("test_cushion_accounts_of_another_profile_are_refused", () => {
    // the other profile's account list does not hold "7"
    const c = asIds(cushionOf({ cushion: { enabled: true, target_amount: 1, account_ids: [7] } }));
    expect(cushionAccountsError(c, [EUR], "PLN")).toBe("unknown account id(s): 7");
  });

  it("normalizes like Python: quantized amounts, upper-cased currency, ids deduplicated", () => {
    const c = cushionOf({
      cushion: {
        enabled: true,
        currency: " pln ",
        target_amount: 5000.5,
        monthly_max: "1000.005",
        target_months: 3.0,
        account_ids: [1, 99, 1],
      },
      unknown: 1,
    });
    expect(c.currency).toBe("PLN");
    expect(c.targetAmount?.toString()).toBe("5000.50");
    expect(c.monthlyMax?.toString()).toBe("1000.00"); // ROUND_HALF_EVEN
    expect(c.targetMonths).toBe(3);
    expect(c.accountIds).toEqual([1, 99]);
  });

  it("missing parts are the defaults; wrong shapes are refused", () => {
    expect(parseBudgetSettings(null)).toEqual({ ok: true, settings: defaultBudgetSettings() });
    expect(parseBudgetSettings({})).toEqual({ ok: true, settings: defaultBudgetSettings() });
    expect(parseBudgetSettings([])).toEqual({ ok: false, error: "settings must be an object" });
    expect(parseBudgetSettings({ cushion: 1 })).toEqual({
      ok: false,
      error: "cushion must be an object",
    });
    expect(parseBudgetSettings({ cushion: { enabled: null } })).toEqual({
      ok: false,
      error: "cushion.enabled must be true or false",
    });
    for (const bad of [true, "NaN", "Infinity", "0", {}]) {
      expect(parseBudgetSettings({ cushion: { target_amount: bad } }).ok, String(bad)).toBe(false);
    }
    for (const empty of [0, false, "", null, {}, []]) {
      expect(cushionOf({ cushion: { account_ids: empty } }).accountIds).toEqual([]);
    }
    expect(parseBudgetSettings({ cushion: { account_ids: [true] } }).ok).toBe(false);
    expect(parseBudgetSettings({ cushion: { target_months: true } }).ok).toBe(false);
  });
});

describe("settings.load", () => {
  it("a missing or corrupt file reads as the defaults", () => {
    expect(loadBudgetSettings(null)).toEqual(defaultBudgetSettings());
    expect(loadBudgetSettings(utf8("{not json"))).toEqual(defaultBudgetSettings());
    expect(loadBudgetSettings(utf8('﻿{"cushion": {"enabled": true, "target_months": 3}}'))).toEqual(
      defaultBudgetSettings(),
    );
    expect(loadBudgetSettings(new Uint8Array([0xff, 0x7b]))).toEqual(defaultBudgetSettings());
    expect(loadBudgetSettings(utf8('{"cushion": {"enabled": true}}'))).toEqual(
      defaultBudgetSettings(),
    );
  });

  it("strict UTF-8 like Python's read_text: any invalid sequence anywhere reads as the defaults", () => {
    const head = '{"note": "';
    const tail = '", "cushion": {"enabled": true, "target_months": 3}}';
    const withBytes = (bad: number[]) => new Uint8Array([...utf8(head), ...bad, ...utf8(tail)]);
    const bad: number[][] = [
      [0xff], // invalid start byte
      [0xc3], // truncated 2-byte sequence
      [0xe2, 0x82], // truncated 3-byte sequence
      [0xc0, 0x80], // overlong NUL
      [0xed, 0xa0, 0x80], // encoded surrogate
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
    ];
    for (const b of bad) expect(loadBudgetSettings(withBytes(b))).toEqual(defaultBudgetSettings());
    // The same document with valid 2, 3 and 4 byte sequences is accepted.
    const ok = loadBudgetSettings(utf8(`${head}zażółć € 😀${tail}`));
    expect(ok.cushion.enabled).toBe(true);
    expect(ok.cushion.targetMonths).toBe(3);
  });

  it("a valid file is parsed", () => {
    const s = loadBudgetSettings(
      utf8(
        '{"cushion": {"account_ids": [2], "currency": null, "enabled": true, "monthly_max": 2000.0, "target_amount": null, "target_months": 3}}',
      ),
    );
    expect(s.cushion.enabled).toBe(true);
    expect(s.cushion.monthlyMax?.toString()).toBe("2000.00");
    expect(s.cushion.accountIds).toEqual([2]);
  });
});
