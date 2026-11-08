// saveStrategyVersion: records only a changed text, refuses an oversized file, issues in the
// `issue_dict` shape, and the fold's m9 rule for two devices recording one edit. Synthetic data only.
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { latestStrategyVersion, strategyVersions } from "../queries/strategy.js";
import { MAX_STRATEGY_FILE_BYTES, saveStrategyVersion, utf8Bytes } from "./strategy.js";
import { type Vault, vault } from "./testing/fixtures.js";

const read = (v: Vault) => v.store.read.bind(v.store);
const MINIMAL = "version: 1\nbase_currency: PLN\n";

describe("saveStrategyVersion", () => {
  it("records a version only when the text differs from the current one", () => {
    const v = vault();
    const first = v.value(saveStrategyVersion, { yamlText: MINIMAL });
    expect(first).toMatchObject({
      recorded: true,
      state: "valid",
      sha256: strategyDigest(MINIMAL, null),
    });
    const same = v.run(saveStrategyVersion, { yamlText: MINIMAL, mdText: null });
    expect(same.ok && same.value).toEqual({ ...first, recorded: false });
    expect(same.ok && same.events).toEqual([]);
    v.value(saveStrategyVersion, { yamlText: MINIMAL, mdText: "" });
    // md "" and no md digest alike (Python `md_text or ""`): still one version
    expect(strategyVersions(read(v))).toHaveLength(1);
    v.value(saveStrategyVersion, { yamlText: "version: [" });
    v.value(saveStrategyVersion, { yamlText: MINIMAL }); // a revert is a new version
    expect(strategyVersions(read(v)).map((r) => [r.version, r.state])).toEqual([
      [3, "valid"],
      [2, "invalid"],
      [1, "valid"],
    ]);
  });

  it("stores issues in the issue_dict shape", () => {
    const v = vault();
    v.value(saveStrategyVersion, { yamlText: "version: [" });
    const issue = latestStrategyVersion(read(v))?.issues[0];
    expect(Object.keys(issue ?? {}).sort()).toEqual(
      ["code", "column", "line", "message", "params", "path", "severity"].sort(),
    );
    expect([issue?.severity, issue?.line]).toEqual(["error", 1]);
  });

  it("refuses a file over the read cap", () => {
    const v = vault();
    const big = `# ${"ż".repeat(MAX_STRATEGY_FILE_BYTES / 2)}\n`;
    expect(utf8Bytes(big)).toBeGreaterThan(MAX_STRATEGY_FILE_BYTES);
    expect(v.run(saveStrategyVersion, { yamlText: big })).toEqual({
      ok: false,
      reason: "strategy_too_large",
    });
    expect(v.run(saveStrategyVersion, { yamlText: MINIMAL, mdText: big }).ok).toBe(false);
    expect(utf8Bytes("aé€\u{1f600}\ud800")).toBe(1 + 2 + 3 + 4 + 3);
  });

  it("refuses a text whose base is no longer the current version, keeps the base it was given", () => {
    const v = vault();
    const first = v.value(saveStrategyVersion, { yamlText: MINIMAL, base: null });
    const second = v.value(saveStrategyVersion, {
      yamlText: "version: 1\nbase_currency: EUR\n",
      base: first.version,
    });
    // A device whose files are still the first version cannot record them over the second.
    expect(
      v.run(saveStrategyVersion, {
        yamlText: "version: 1\nbase_currency: USD\n",
        base: first.version,
      }),
    ).toEqual({ ok: false, reason: "base_changed" });
    expect(v.run(saveStrategyVersion, { yamlText: MINIMAL, base: null })).toEqual({
      ok: false,
      reason: "base_changed",
    });
    expect(strategyVersions(read(v)).map((r) => r.gid)).toEqual([second.version, first.version]);
    expect(
      v.store.read<{ base_gid: string | null; base_known: number }>(
        "SELECT base_gid, base_known FROM inv_strategy_versions ORDER BY version",
      ),
    ).toEqual([
      { base_gid: null, base_known: 1 },
      { base_gid: first.version, base_known: 1 },
    ]);
  });

  it("two devices recording one external edit keep one version (m9)", () => {
    const v = vault();
    const a = v.run(saveStrategyVersion, { yamlText: MINIMAL });
    // a second device decided before it saw the first version: the fold drops the duplicate
    const twin = a.ok ? a.events[0] : undefined;
    if (twin === undefined) throw new Error("no event");
    v.store.applyEnvelopes([
      {
        ...twin,
        eid: "01JK0000000000000000000001",
        gid: "01JK0000000000000000000002",
        hlc: v.env.hlc.tick(),
      },
    ]);
    expect(strategyVersions(read(v)).map((r) => r.version)).toEqual([1]);
  });
});
