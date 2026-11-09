import { D } from "@cashu/domain";
import { bananaScale } from "@cashu/domain/core";
import { describe, expect, it } from "vitest";
import { cur, cur0 } from "./format.js";
import {
  bananaMoney,
  bananaScaleVault,
  hideAmount,
  incognitoKey,
  installIncognitoStore,
  isIncognito,
  onIncognitoChange,
  setBananaScale,
  setIncognito,
} from "./incognito.js";

describe("incognito flag", () => {
  it("reads the installed store once, writes every change and tells subscribers", () => {
    const saved: boolean[] = [];
    let loads = 0;
    installIncognitoStore({
      load: () => {
        loads++;
        return true;
      },
      save: (on) => saved.push(on),
    });
    expect(isIncognito()).toBe(true);
    expect(isIncognito()).toBe(true);
    expect(loads).toBe(1);
    expect(hideAmount("-11 600,00 zł")).toBe("-••• zł");
    let calls = 0;
    const off = onIncognitoChange(() => calls++);
    setIncognito(false);
    off();
    setIncognito(true);
    expect(saved).toEqual([false, true]);
    expect(calls).toBe(1);
  });

  it("holds the flag in memory when the store fails", () => {
    installIncognitoStore({
      load: () => {
        throw new Error("storage blocked");
      },
      save: () => {
        throw new Error("storage blocked");
      },
    });
    expect(isIncognito()).toBe(false);
    setIncognito(true);
    expect(isIncognito()).toBe(true);
    expect(hideAmount("12 zł")).toBe("••• zł");
  });
});

describe("banana scale", () => {
  it("shows money in bananas and masks what it cannot convert", () => {
    installIncognitoStore({ load: () => true, save: () => {} });
    setBananaScale(bananaScale("salary", D("8000"), { EUR: 4 }), "vault-a");
    expect(incognitoKey()).toMatch(/^bananas:vault-a:salary:/);
    expect(bananaScaleVault()).toBe("vault-a");
    expect(cur(-2000, "PLN")).toMatch(/^-🍌 250$/);
    expect(cur0(8000, "PLN")).toMatch(/^🍌 1[\s,.\u00a0\u202f]?000$/);
    expect(bananaMoney(200, "EUR")).toBe("🍌 100");
    expect(bananaMoney(5, "USD")).toBeNull();
    expect(cur(5, "USD")).not.toMatch(/\d/);
    expect(hideAmount("🍌 12")).toBe("🍌 12");
    setIncognito(false);
    expect(incognitoKey()).toBe("off");
    expect(bananaMoney(200, "EUR")).toBeNull();
  });

  it("masks with dots without a scale and tells subscribers when the scale changes", () => {
    installIncognitoStore({ load: () => true, save: () => {} });
    setBananaScale(null);
    expect(incognitoKey()).toBe("masked");
    let calls = 0;
    const off = onIncognitoChange(() => calls++);
    expect(cur(12, "PLN")).toBe(hideAmount(cur(12, "PLN")));
    expect(cur(12, "PLN")).not.toMatch(/\d/);
    setBananaScale(bananaScale("portfolio", D("1000"), {}));
    setBananaScale(bananaScale("portfolio", D("1000"), {}));
    off();
    expect(calls).toBe(1);
    setBananaScale(null);
  });
});
