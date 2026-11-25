// The first sync's line on the pairing screen: one step at a time from the vault's status, each with its
// own exact counts (the replay check wins over the pass's counts), and the copy each step reads.
import { setLanguageForTests } from "@cashu/i18n";
import type { VaultSyncStatus } from "../../services/vaultEngine";
import { firstSyncStep } from "./firstSyncStep";
import { S } from "./Pair.strings";

const base: VaultSyncStatus = {
  vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
  phase: "receiving",
  syncing: true,
  remote: true,
  unpushed: false,
};

afterEach(() => setLanguageForTests("en"));

/** `fn` under the UI language `lang`. */
function inLang<T>(lang: "pl" | "en", fn: () => T): T {
  setLanguageForTests(lang);
  return fn();
}

describe("the first sync's step", () => {
  it("shows receiving, then saving, then the check, and nothing before the relay listed anything", () => {
    expect(firstSyncStep(undefined)).toBeNull();
    expect(
      firstSyncStep({ ...base, progress: { phase: "receiving", done: 0, total: 0, events: 0 } }),
    ).toBeNull();
    expect(
      firstSyncStep({
        ...base,
        progress: { phase: "receiving", done: 1_200_000, total: 2_360_000, events: 0 },
      }),
    ).toEqual({ step: "receiving", done: 1_200_000, total: 2_360_000 });
    expect(
      firstSyncStep({
        ...base,
        progress: { phase: "saving", done: 2_000_000, total: 2_360_000, events: 19_000 },
      }),
    ).toEqual({ step: "saving", done: 2_000_000, total: 2_360_000, events: 19_000 });
    expect(
      firstSyncStep({
        ...base,
        progress: { phase: "saving", done: 2_360_000, total: 2_360_000, events: 22_187 },
        replay: { done: 140, total: 350 },
      }),
    ).toEqual({ step: "checking", done: 140, total: 350 });
  });

  it("reads megabytes received of the total, the changes saved and the check's share", () => {
    expect(inLang("en", () => S.firstSyncProgress(1_234_567, 2_360_000))).toBe(
      "Receiving your data from your Mac · 1.2 of 2.3 MB",
    );
    expect(inLang("pl", () => S.firstSyncProgress(1_234_567, 2_360_000))).toBe(
      "Odbieranie danych z Maca · 1,2 z 2,3 MB",
    );
    expect(inLang("en", () => S.firstSyncSaving(22_187))).toBe(
      "Saving on this phone · 22,187 changes",
    );
    expect(inLang("pl", () => S.firstSyncSaving(22_187))).toBe(
      "Zapisywanie na tym telefonie · 22\u00a0187 zmian",
    );
    expect(inLang("pl", () => S.firstSyncSaving(2))).toBe(
      "Zapisywanie na tym telefonie · 2 zmiany",
    );
    expect(inLang("en", () => S.firstSyncChecking(40))).toBe("Checking this phone's copy · 40%");
  });
});
