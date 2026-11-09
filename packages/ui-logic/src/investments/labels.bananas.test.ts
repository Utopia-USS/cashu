import { D } from "@cashu/domain";
import { bananaScale } from "@cashu/domain/core";
import { afterEach, expect, it } from "vitest";
import { installIncognitoStore, setBananaScale } from "../core/incognito.js";
import { money, money0, plainMoney, unitPrice } from "./labels.js";

afterEach(() => setBananaScale(null));

it("puts position money on the banana scale but never a unit price or form-adjacent money", () => {
  installIncognitoStore({ load: () => true, save: () => {} });
  setBananaScale(bananaScale("salary", D("8000"), {}), "vault-a");
  expect(money(4000, "PLN", true)).toBe("+🍌 500");
  expect(money0(-8000, "PLN")).toMatch(/^-🍌 1.?000$/u);
  for (const text of [unitPrice(148.6, "PLN"), plainMoney(4000, "PLN", true)]) {
    expect(text).not.toMatch(/\d|🍌/u);
  }
});
