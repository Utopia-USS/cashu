// Translation of tests/test_registries.py (test-for-test; DB / HTTP / parser-bound tests are listed in
// ~/cashu-lab/checkpoints/S06.md with the reason they are not here).

import { describe, expect, it } from "vitest";
import { accountType, RegistryConflictError } from "./accountTypes.js";
import { BUILTIN_MODULES, builtinRegistry } from "./builtinModules.js";
import { INSTITUTION_PATTERN, InstitutionRegistry, institution, slugId } from "./institutions.js";
import {
  createCoreRegistry,
  getModule,
  moduleSpec,
  type SetupStep,
  setupState,
  setupStepDicts,
  UnknownModuleError,
  withDependencies,
} from "./modules.js";

const reg = builtinRegistry();

describe("modules", () => {
  // test_registry_lists_modules_in_display_order
  it("registry lists modules in display order", () => {
    expect([...reg.modules.keys()]).toEqual(["budget", "assets", "loans", "investments"]);
    for (const id of ["budget", "assets", "loans"]) {
      const spec = getModule(reg, id);
      expect(spec.available).toBe(true);
      expect(spec.networth).toBe(true);
      expect(spec.skill).toBe(`/${id}-setup`);
    }
  });

  // test_investments_spec
  it("investments spec", () => {
    const spec = getModule(reg, "investments");
    expect(spec.available).toBe(true);
    expect(spec.name).toBe("Inwestycje");
    expect(spec.cliName).toBe("invest");
    expect(spec.networth).toBe(true);
    expect(spec.skill).toBe("/investments-setup");
    expect(Object.fromEntries(spec.institutions.map((i) => [i.id, i.kind]))).toEqual({
      dif: "broker",
      xtb: "broker",
      binance: "exchange",
      zonda: "exchange",
    });
    expect(reg.institutions.ids("broker")).toEqual(expect.arrayContaining(["dif", "xtb"]));
    expect(new Set(reg.institutions.ids("exchange"))).toEqual(new Set(["binance", "zonda"]));
    expect(reg.institutions.ids("bank")).not.toContain("dif");
    expect(reg.institutions.csvIds()).not.toContain("dif");
  });

  // test_unknown_module
  it("unknown module", () => {
    expect(() => getModule(reg, "nope")).toThrow(UnknownModuleError);
  });

  // test_dependencies_are_enabled_together
  it("dependencies are enabled together", () => {
    const extra = moduleSpec({
      id: "extra",
      name: "Extra",
      description: "x",
      dependsOn: ["budget"],
    });
    const withExtra = createCoreRegistry([...BUILTIN_MODULES, extra]);
    expect(withDependencies(withExtra, ["extra"])).toEqual(["budget", "extra"]);
    expect(withDependencies(withExtra, ["loans", "budget"])).toEqual(["budget", "loans"]);
  });

  // test_setup_status_states_and_step_statuses
  it("setup status states and step statuses", () => {
    const steps = (...done: boolean[]): SetupStep[] =>
      done.map((d, i) => ({
        id: `s${i}`,
        title: "T",
        description: "D",
        done: d,
        actions: [{ kind: "cli", label: "Kopiuj", target: "cashu x" }],
        optional: false,
      }));
    const statuses = (s: SetupStep[]) => setupStepDicts(s).map((d) => d.status);

    expect(setupState(steps(false, false))).toBe("empty");
    expect(statuses(steps(false, false))).toEqual(["on", "todo"]);
    expect(setupState(steps(true, false, false))).toBe("partial");
    expect(statuses(steps(true, false, false))).toEqual(["done", "on", "todo"]);
    expect(setupState(steps(true, true))).toBe("ready");
    expect(setupStepDicts(steps(false, true))[1]?.status).toBe("done"); // done stays done
    expect(setupState([])).toBe("empty");
    expect(setupStepDicts(steps(true))[0]?.actions).toEqual([
      { kind: "cli", label: "Kopiuj", target: "cashu x" },
    ]);
  });
});

describe("account types and net-worth buckets", () => {
  // test_account_types_carry_module_metadata
  it("account types carry module metadata", () => {
    const byId = new Map(reg.accountTypes.all().map((t) => [t.id, t]));
    expect(new Set(byId.keys())).toEqual(
      new Set([
        "checking",
        "savings",
        "credit",
        "cash",
        "property",
        "vehicle",
        "investment",
        "other",
        "mortgage",
        "loan",
        "brokerage",
      ]),
    );
    const t = (id: string) => byId.get(id) ?? expect.fail(id);
    expect([t("credit").module, t("credit").sign]).toEqual(["budget", "credit"]);
    expect([
      t("mortgage").module,
      t("mortgage").sign,
      t("mortgage").liquid,
      t("mortgage").bucket,
    ]).toEqual(["loans", "liability", false, "mortgage"]);
    expect([t("vehicle").module, t("vehicle").liquid, t("vehicle").bucket]).toEqual([
      "assets",
      false,
      "vehicle",
    ]);
    expect(t("investment").liquid && t("investment").bucket === "money").toBe(true);
    expect([
      t("brokerage").module,
      t("brokerage").sign,
      t("brokerage").liquid,
      t("brokerage").bucket,
    ]).toEqual(["investments", "asset", true, "investments"]);
    expect(reg.accountTypes.buckets().map((b) => b.id)).toEqual([
      "money",
      "investments",
      "property",
      "vehicle",
      "mortgage",
      "loan",
    ]);
    expect(
      new Set(
        reg.accountTypes
          .buckets()
          .filter((b) => b.liability)
          .map((b) => b.id),
      ),
    ).toEqual(new Set(["mortgage", "loan"]));
  });

  // test_unknown_account_type_is_a_liquid_asset
  it("unknown account type is a liquid asset", () => {
    const info = reg.accountTypes.get("brokerage-test");
    expect([info.sign, info.liquid, info.bucket]).toEqual(["asset", true, "money"]);
  });

  // test_conflicting_registration_is_rejected
  it("conflicting registration is rejected", () => {
    const fresh = builtinRegistry();
    expect(() => fresh.accountTypes.registerType(accountType("credit", "other", "X"))).toThrow(
      /already registered/,
    );
    expect(() => fresh.accountTypes.registerType(accountType("credit", "other", "X"))).toThrow(
      RegistryConflictError,
    );
    fresh.accountTypes.registerType(fresh.accountTypes.get("credit")); // the same entry again is fine
  });

  it("a spec whose bucket clashes with another module's is rejected", () => {
    const clash = moduleSpec({
      id: "extra",
      name: "Extra",
      description: "x",
      networthBuckets: [{ id: "loan", label: "Inny", order: 1, liability: false, labelEn: null }],
    });
    expect(() => createCoreRegistry([...BUILTIN_MODULES, clash])).toThrow(/already registered/);
  });
});

describe("institutions", () => {
  // test_builtin_institutions_keep_the_upstream_ids
  it("builtin institutions keep the upstream ids", () => {
    expect(reg.institutions.ids()).toEqual(
      expect.arrayContaining(["mbank", "erste", "pekao", "manual"]),
    );
    expect(reg.institutions.get("manual").kind).toBe("manual");
    expect(reg.institutions.csvIds()).toEqual(["mbank", "erste", "pekao"]);
    expect(reg.institutions.displayName("erste", "pl")).toBe("Erste Bank Polska");
    // An id no entry knows (a generic Open Banking bank) reads as words; never throws.
    expect(reg.institutions.displayName("gone-bank", "pl")).toBe("Gone Bank");
    expect(reg.institutions.displayName("ing-bank-slaski", "pl")).toBe("Ing Bank Slaski");
    expect(reg.institutions.displayName("", "pl")).toBe("");
    expect(reg.institutions.displayName("manual", "en")).toBe("Manual");
    expect(reg.institutions.displayName("manual", "pl")).toBe("Ręcznie");
  });

  // test_open_banking_aspsp_mapping
  it("open banking aspsp mapping", () => {
    const bank = (name: string | null) => reg.institutions.bankFromAspsp(name);
    expect(bank("mBank S.A.")).toBe("mbank");
    expect(bank("Santander Bank Polska")).toBe("erste");
    expect(bank("Erste Bank Polska")).toBe("erste");
    expect(bank("Bank Pekao SA")).toBe("pekao");
    expect(bank("Bank Millennium")).toBe("millennium");
    expect(bank("Revolut")).toBe("revolut");
    // Python raises ValueError("... pass bank explicitly"); the port returns null.
    expect(bank("")).toBeNull();
    expect(bank(null)).toBeNull();
  });

  // test_unknown_aspsp_maps_to_a_generic_institution_id
  it("unknown aspsp maps to a generic institution id", () => {
    const bank = (name: string) => reg.institutions.bankFromAspsp(name);
    expect(bank("Bank Test")).toBe("bank-test");
    expect(bank("ING Bank Śląski S.A.")).toBe("ing-bank-slaski-s-a");
    expect(bank("Łódzki Bank Spółdzielczy")).toBe("lodzki-bank-spoldzielczy");
    expect(bank("4finance")).toBe("bank-4finance");
    const long = bank("Bank Spółdzielczy w Ząbkowicach Śląskich Oddział Bardo");
    // A slug never collides with another institution's id.
    expect(bank("Manual")).toBe("ob-manual");
    for (const slug of [long, bank("Bank Test"), bank("4finance"), "ob-manual"]) {
      expect(slug).toMatch(INSTITUTION_PATTERN);
    }
    expect(reg.institutions.displayName(bank("Bank Test") ?? "", "pl")).toBe("Bank Test");
  });

  it("slug ids drop what has no ASCII letters or digits", () => {
    expect(slugId("!!!")).toBe("");
    expect(slugId("Straße Øst đ")).toBe("strasse-ost-d");
    expect(slugId("a".repeat(40))).toHaveLength(32);
    expect(slugId(`${"a".repeat(31)}-b`)).toBe("a".repeat(31));
  });

  // test_adding_a_bank_is_one_registry_entry (the registry half; parser detection is S07's)
  it("adding a bank is one registry entry", () => {
    const institutions = new InstitutionRegistry();
    institutions.register(
      institution("testbank", "bank", "Bank Test", {
        csvImporter: "testbank",
        aspspPatterns: ["testbank"],
      }),
    );
    expect(institutions.csvIds()).toContain("testbank");
    expect(institutions.bankFromAspsp("TestBank Online")).toBe("testbank");
    expect(() => institutions.register(institution("testbank", "bank", "Other"))).toThrow(
      /already registered/,
    );
  });
});
