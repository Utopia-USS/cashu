import { D, Decimal, Money } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { deepEqual, replaceEqual } from "./structural.js";

describe("replaceEqual", () => {
  it("keeps the identity of unchanged rows and of an unchanged whole", () => {
    const prev = [
      { gid: "a", name: "Konto", balance: new Money(D("10.50"), "PLN") },
      { gid: "b", name: "Lokata", balance: new Money(D("1"), "EUR") },
    ];
    const same = structuredClone(prev).map((r, i) => ({
      ...r,
      balance: new Money(D(i === 0 ? "10.50" : "1"), r.balance.currency),
    }));
    expect(replaceEqual(prev, same)).toBe(prev);

    const next = [
      { gid: "a", name: "Konto", balance: new Money(D("10.50"), "PLN") },
      { gid: "b", name: "Lokata 2", balance: new Money(D("1"), "EUR") },
      { gid: "c", name: "Nowe", balance: new Money(D("0"), "PLN") },
    ];
    const shared = replaceEqual(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).not.toBe(prev[1]);
    expect(shared[1]?.balance).toBe(prev[1]?.balance);
    expect(shared[2]).toBe(next[2]);
  });

  it("compares decimals by value and exponent, like Python", () => {
    expect(deepEqual(D("1.50"), Decimal.parse("1.50"))).toBe(true);
    expect(deepEqual(D("1.50"), D("1.5"))).toBe(false);
    expect(deepEqual(new Money(D("1"), "PLN"), new Money(D("1"), "EUR"))).toBe(false);
    expect(replaceEqual({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Map([[1, "x"]]), new Map([[1, "y"]]))).toBe(false);
  });
});
