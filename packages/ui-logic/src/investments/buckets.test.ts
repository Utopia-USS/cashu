import { setLanguageForTests } from "@cashu/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { allocGeneric, isShownSignal, unnameBuckets } from "./buckets.js";

afterEach(() => setLanguageForTests("pl"));

describe("unnameBuckets", () => {
  it("names an expression over the owner's bucket by its phrase in both languages", () => {
    setLanguageForTests("en");
    const en = unnameBuckets(
      'bucket_drift_pp("core") <= -3 and bucket_target("core") > 0 and bucket_value("core") > 1',
    );
    expect(en).toBe("bucket drift <= -3 and bucket target > 0 and bucket value > 1");
    expect(unnameBuckets(en)).toBe(en);
    setLanguageForTests("pl");
    expect(unnameBuckets('bucket_drift_pp("core") <= -3')).toBe("dryf koszyka <= -3");
  });

  it("keeps generic ids and drops the owner's ones from prose", () => {
    setLanguageForTests("pl");
    expect(unnameBuckets('bucket_weight("global_equity") > 40%')).toBe(
      'bucket_weight("global_equity") > 40%',
    );
    expect(unnameBuckets("Koszyk core: warunek spełniony")).toBe("Koszyk: warunek spełniony");
    expect(unnameBuckets('bucket_id != "core"')).toBe('bucket_id != "…"');
  });
});

describe("isShownSignal and allocGeneric", () => {
  it("hides a drift of the owner's bucket and gates the allocation on generic buckets", () => {
    expect(isShownSignal({ kind: "allocation_drift", payload: { bucket_id: "core" } })).toBe(false);
    expect(isShownSignal({ kind: "allocation_drift", payload: { bucket_id: "cash" } })).toBe(true);
    expect(allocGeneric({ buckets: [{ bucket_id: "cash" }, { bucket_id: "bonds" }] })).toBe(true);
    expect(allocGeneric({ buckets: [{ bucket_id: "cash" }, { bucket_id: "core" }] })).toBe(false);
    expect(allocGeneric({ buckets: [{ bucket_id: "cash", generic: false }] })).toBe(false);
    expect(allocGeneric({ buckets: [] })).toBe(false);
  });
});
