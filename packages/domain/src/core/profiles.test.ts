// Translation of the slug / module / validation parts of tests/test_profiles.py and of
// test_own_ibans_are_per_profile (the rest of that file is API / DB bound; see the S06 checkpoint).

import { describe, expect, it } from "vitest";
import { ownIbans } from "./accounts.js";
import { builtinRegistry } from "./builtinModules.js";
import { moduleName } from "./modules.js";
import {
  casefold,
  checkNameFree,
  cleanCurrency,
  cleanModules,
  cleanName,
  cleanPrivacy,
  profileDisplayName,
  slugify,
  uniqueSlug,
} from "./profiles.js";

const reg = builtinRegistry();

describe("slugs", () => {
  // test_slugs_are_ascii_and_unique
  it("slugs are ascii and unique", () => {
    expect(slugify("Żółć Gęślą")).toBe("zolc-gesla");
    expect(slugify("Jakub & Marta!")).toBe("jakub-marta");
    expect(slugify("!!!")).toBe("profil");
    expect(slugify("a".repeat(100))).toHaveLength(40);
  });

  // test_profiles_crud: "Jakub Łoś" -> "jakub-los"
  it("the l with stroke is transliterated", () => {
    expect(slugify("Jakub Łoś")).toBe("jakub-los");
  });

  // test_slug_collision_gets_a_suffix
  it("slug collision gets a suffix", () => {
    const a = uniqueSlug("Dom", []);
    const b = uniqueSlug("Dom!", [a]);
    expect([a, b]).toEqual(["dom", "dom-2"]);
    expect(uniqueSlug("Dom", ["dom", "dom-2"])).toBe("dom-3");
  });
});

describe("modules of a profile", () => {
  // test_modules
  it("modules are listed in display order with names", () => {
    expect([...reg.modules.keys()]).toEqual(["budget", "assets", "loans", "investments"]);
    for (const spec of reg.modules.values()) {
      expect(spec.dependsOn).toEqual([]);
      expect(spec.available).toBe(true);
      expect(moduleName(spec, "pl")).toBeTruthy();
      expect(spec.description).toBeTruthy();
    }
  });

  // test_profiles_crud: modules come back in display order, whatever order was asked
  it("a module choice comes back in display order", () => {
    expect(cleanModules(reg, ["loans", "budget", "loans"])).toEqual({
      ok: true,
      value: ["budget", "loans"],
    });
    expect(cleanModules(reg, [])).toEqual({ ok: true, value: [] });
  });
});

describe("profile validation", () => {
  // test_profile_validation
  it("profile validation", () => {
    const names = [{ id: "1", name: "Jan" }];
    // names are unique ignoring case (the UI blocks "jan" next to "Jan" too)
    const dup = checkNameFree(names, (cleanName(" jan ") as { value: string }).value);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.problem.kind).toBe("conflict");
      expect(dup.problem.message).toContain("already exists");
    }
    const others = [...names, { id: "2", name: "Ola" }];
    expect(checkNameFree(others, "JAN", "2").ok).toBe(false); // renaming Ola to JAN
    expect(checkNameFree(others, "Jan", "1").ok).toBe(true); // renaming Jan to itself

    expect(cleanName("  ")).toEqual({
      ok: false,
      problem: { kind: "invalid", message: "name is required" },
    });
    expect(cleanCurrency("EURO").ok).toBe(false);
    expect(cleanPrivacy("everything").ok).toBe(false);
    const unknown = cleanModules(reg, ["budget", "nope"]);
    expect(unknown).toEqual({
      ok: false,
      problem: { kind: "invalid", message: "unknown module(s): nope" },
    });
  });

  // test_profiles_crud: "pln" is stored as "PLN"
  it("currency is trimmed and upper-cased", () => {
    expect(cleanCurrency(" pln ")).toEqual({ ok: true, value: "PLN" });
    expect(cleanCurrency(null).ok).toBe(false);
  });

  it("names are at most 80 characters", () => {
    expect(cleanName("x".repeat(80)).ok).toBe(true);
    expect(cleanName("x".repeat(81))).toEqual({
      ok: false,
      problem: { kind: "invalid", message: "name is too long (max 80 characters)" },
    });
  });

  it("casefold folds like Python for names", () => {
    expect(casefold("Straße")).toBe(casefold("STRASSE"));
    expect(casefold("ŁUKASZ")).toBe("łukasz");
  });

  it("the untouched default profile follows the UI language", () => {
    expect(profileDisplayName({ slug: "default", name: "Domyślny" }, "en")).toBe("Default");
    expect(profileDisplayName({ slug: "default", name: "Domyślny" }, "pl")).toBe("Domyślny");
    expect(profileDisplayName({ slug: "default", name: "Dom" }, "en")).toBe("Dom");
  });
});

describe("own IBANs", () => {
  // test_own_ibans_are_per_profile (the core half: own IBANs come from the profile's accounts only)
  it("own ibans are per profile", () => {
    const jan = [{ iban: "99114000000000000000000101" }];
    const ola = [{ iban: "PL99109000000000000000000202" }, { iban: null }];
    expect(ownIbans(jan)).toEqual(new Set(["99114000000000000000000101"]));
    expect(ownIbans(ola)).toEqual(new Set(["99109000000000000000000202"]));
    // Ola's account is not one of Jan's: a transfer to it is a real outflow for Jan.
    expect(ownIbans(jan).has("99109000000000000000000202")).toBe(false);
  });
});
