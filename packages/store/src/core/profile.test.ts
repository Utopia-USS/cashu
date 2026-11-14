// The phone's profile entry (`@cashu/store/core/profile`): who the vault is and which modules it
// shows, in the build's module order. Synthetic profile only.
import { describe, expect, it } from "vitest";
import { profileIdentity as overviewIdentity } from "../overview/index.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { createProfile, setModules } from "./commands.js";
import { enabledModules, pendingProposalsCount, profileIdentity } from "./profile.js";
import { createProposal, rejectProposal } from "./proposal-commands.js";

describe("core profile queries", () => {
  it("reads nothing before the profile exists", () => {
    const store = openTestStore();
    expect(runQuery(store, profileIdentity, undefined).value).toBeNull();
    expect(runQuery(store, enabledModules, undefined).value).toEqual([]);
  });

  it("reads the identity and the enabled modules in module order", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      run(store, env, createProfile, {
        slug: "synthetic-home",
        name: "Synthetic Home",
        baseCurrency: "PLN",
        modules: ["loans", "investments", "budget"],
      }).ok,
    ).toBe(true);
    expect(runQuery(store, profileIdentity, undefined).value).toEqual({
      slug: "synthetic-home",
      name: "Synthetic Home",
      baseCurrency: "PLN",
    });
    expect(overviewIdentity).toBe(profileIdentity);
    const modules = runQuery(store, enabledModules, undefined);
    expect(modules.value).toEqual(["budget", "loans", "investments"]);
    expect(modules.tables).toEqual(new Set(["profile_modules"]));
    expect(run(store, env, setModules, { moduleIds: ["assets", "budget"] }).ok).toBe(true);
    expect(runQuery(store, enabledModules, undefined).value).toEqual(["budget", "assets"]);
  });

  it("counts the pending proposals only", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(runQuery(store, pendingProposalsCount, undefined).value).toBe(0);
    const propose = () => {
      const out = run(store, env, createProposal, {
        kind: "strategy",
        summary: "Synthetic strategy change",
        reason: null,
        payload: { base_sha256: "synthetic" },
        source: "synthetic",
      });
      if (!out.ok) throw new Error("synthetic proposal refused");
      return out.value.proposalGid;
    };
    const first = propose();
    propose();
    const count = runQuery(store, pendingProposalsCount, undefined);
    expect(count.value).toBe(2);
    expect(count.tables).toEqual(new Set(["proposals"]));
    expect(run(store, env, rejectProposal, { proposalGid: first, note: null }).ok).toBe(true);
    expect(runQuery(store, pendingProposalsCount, undefined).value).toBe(1);
  });
});
