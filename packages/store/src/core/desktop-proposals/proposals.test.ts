import { describe, expect, it } from "vitest";
import { run, testEnv } from "../../testing/commands.js";
import { openTestStore } from "../../testing/store.js";
import { createProfile } from "../commands.js";
import { createProposal } from "../proposal-commands.js";
import { proposalDetail, proposalList } from "./index.js";

describe("canonical desktop proposal reads", () => {
  it("lists four kinds without payload and masks only owner-incognito delivery", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      run(store, env, createProfile, { slug: "home", name: "Home", modules: ["investments"] }).ok,
    ).toBe(true);
    const gids: string[] = [];
    for (const kind of ["strategy", "custom_rule", "import", "budget_import"] as const) {
      const result = run(store, env, createProposal, {
        kind,
        summary: `${kind} synthetic`,
        summaryParams: { account: "Synthetic account", new: 2 },
        reason: "Synthetic reason",
        source: "synthetic",
        payload: { marker: "synthetic-private" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) gids.push(result.value.proposalGid);
    }
    const read = store.read.bind(store);
    const listed = proposalList.run(read, { status: "pending", privacy: false });
    expect(listed).toHaveLength(4);
    expect(listed.map((row) => row.kind).sort()).toEqual([
      "budget_import",
      "custom_rule",
      "import",
      "strategy",
    ]);
    expect(JSON.stringify(listed)).not.toContain("synthetic-private");
    // Python `proposal_dict`: summary_code = the kind, summary_params stored in the payload.
    for (const row of listed)
      expect(row).toMatchObject({
        summaryCode: row.kind,
        summaryParams: { account: "Synthetic account", new: 2 },
      });
    expect(proposalList.run(read, { status: "pending", privacy: true })[0]).toMatchObject({
      summary: "",
      summaryParams: {},
      reason: null,
      source: "",
    });
    for (const gid of gids) {
      const detail = proposalDetail.run(read, { gid, privacy: false });
      expect(detail?.payload).toEqual({
        marker: "synthetic-private",
        summary_params: { account: "Synthetic account", new: 2 },
      });
      expect(detail?.summaryParams).toEqual({ account: "Synthetic account", new: 2 });
      expect(proposalDetail.run(read, { gid, privacy: true })).toMatchObject({
        payload: {},
        summaryParams: {},
      });
    }
    expect(proposalDetail.run(read, { gid: "not-a-gid", privacy: false })).toBeNull();
  });
});
