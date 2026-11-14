import { expect, it } from "vitest";
import { NameGuard } from "../privacy/names.js";
import { guardInputFingerprint } from "./delivery.js";

it("canonicalizes unordered guard inputs without loading the secret", () => {
  let loads = 0;
  const secret = () => {
    loads++;
    throw new Error("must not load a key for delivery");
  };
  const a = new NameGuard({
    profileId: 1n,
    names: ["Alpha", "Beta"],
    symbols: ["1234", "5678"],
    privatePayees: ["One", "Two"],
    secret,
  });
  const b = new NameGuard({
    profileId: 1n,
    names: ["Beta", "Alpha"],
    symbols: ["5678", "1234"],
    privatePayees: ["Two", "One"],
    secret,
  });
  expect(guardInputFingerprint(a) === guardInputFingerprint(b)).toBe(true);
  expect(loads).toBe(0);
});
it("preserves effective equal-length replacement chains and duplicate alias precedence", () => {
  const first = new NameGuard({
    profileId: 1n,
    strictAliases: [
      ["abc", "xyz"],
      ["xyz", "Public"],
    ],
  });
  const reversed = new NameGuard({
    profileId: 1n,
    strictAliases: [
      ["xyz", "Public"],
      ["abc", "xyz"],
    ],
  });
  expect(first.swapAliases("abc")).toBe("Public");
  expect(reversed.swapAliases("abc")).toBe("xyz");
  expect(guardInputFingerprint(first) === guardInputFingerprint(reversed)).toBe(false);
  const one = new NameGuard({ profileId: 1n, strictAliases: [["abc", "abc X"]] });
  const duplicate = new NameGuard({
    profileId: 1n,
    strictAliases: [
      ["abc", "abc X"],
      ["abc", "abc X"],
    ],
  });
  expect(one.swapAliases("abc")).toBe("abc X");
  expect(duplicate.swapAliases("abc")).toBe("abc X X");
  expect(guardInputFingerprint(one) === guardInputFingerprint(duplicate)).toBe(false);
});
it("also preserves publicName's original strip/casefold first-match order", () => {
  const a = new NameGuard({
    profileId: 1n,
    strictAliases: [
      ["abc", "Public A"],
      [" ABC ", "Public B"],
    ],
  });
  const b = new NameGuard({
    profileId: 1n,
    strictAliases: [
      [" ABC ", "Public B"],
      ["abc", "Public A"],
    ],
  });
  expect(a.swapAliases("abc")).toBe(b.swapAliases("abc"));
  expect(a.publicName("aBc")).toBe("Public A");
  expect(b.publicName("aBc")).toBe("Public B");
  expect(guardInputFingerprint(a) === guardInputFingerprint(b)).toBe(false);
});
