// Strategy versions and rule runs (S25 spec 4.6, 4.7; scenario S1). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { converge, DEV_B, Events, rows, ulid } from "./testing/kit.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("proposal outcomes and the strategy version an approval caused (S31c)", () => {
  const fixture = () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const proposal = ulid(50);
    const created = a.make(
      "proposal.created",
      proposal,
      { kind: "strategy", summary: "s", reason: null, payload: {}, source: "mcp" },
      { wall: 5 },
    );
    const approved = a.make(
      "proposal.approved",
      proposal,
      { result: { version: 2 } },
      { wall: 30 },
    );
    const caused = a.make(
      "strategy.versionSaved",
      ulid(2),
      { sha256: SHA_B },
      { wall: 31, cause: approved.eid },
    );
    const failed = a.make(
      "proposal.applyFailed",
      proposal,
      { result: { error_code: "write_failed" }, approval: approved.eid },
      { wall: 40 },
    );
    const before = a.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }, { wall: 10 });
    const proposalRow = (store: Parameters<Parameters<typeof converge>[1]>[0]) =>
      store.read<{ status: string; result: string; reviewed_at: string }>(
        "SELECT status, result, reviewed_at FROM proposals",
      );
    const rejected = b.make("proposal.rejected", proposal, { note: "nie teraz" }, { wall: 20 });
    return { a, b, proposal, before, created, approved, caused, failed, rejected, proposalRow };
  };
  const versions = (store: Parameters<Parameters<typeof converge>[1]>[0]) =>
    rows(store, "inv_strategy_versions").map((v) => v.gid);
  const statusOf = (store: Parameters<Parameters<typeof converge>[1]>[0]) =>
    store.read<{ status: string }>("SELECT status FROM proposals").map((p) => p.status);

  it("F1 race: the losing approver's write failure leaves the winner's version and status", () => {
    const { a, b, proposal, before, created } = fixture();
    // B approves first (hlc 10) and records its version; A approves later (hlc 12, loses FWW),
    // its own write fails and it reports that failure for ITS approval (hlc 13).
    const approvedB = b.make(
      "proposal.approved",
      proposal,
      { result: { version: 2 } },
      { wall: 8 },
    );
    const versionB = b.make(
      "strategy.versionSaved",
      ulid(3),
      { sha256: SHA_B },
      { wall: 9, cause: approvedB.eid },
    );
    const approvedA = a.make(
      "proposal.approved",
      proposal,
      { result: { version: 2 } },
      { wall: 12 },
    );
    const failedA = a.make(
      "proposal.applyFailed",
      proposal,
      { result: { error_code: "write_failed" }, approval: approvedA.eid },
      { wall: 13 },
    );
    converge([before, created, approvedB, versionB, approvedA, failedA], (store) => {
      expect(versions(store)).toEqual([ulid(1), ulid(3)]);
      expect(statusOf(store)).toEqual(["approved"]);
    });
  });

  it("an applyFailed sorting before its approval neither revokes nor fails the proposal", () => {
    const { a, proposal, before, created, approved, caused } = fixture();
    const early = a.make(
      "proposal.applyFailed",
      proposal,
      { result: { error_code: "write_failed" }, approval: approved.eid },
      { wall: 20 },
    );
    converge([before, created, early, approved, caused], (store) => {
      expect(versions(store)).toEqual([ulid(1), ulid(2)]);
      expect(statusOf(store)).toEqual(["approved"]);
    });
  });

  it("an applyFailed revokes only its own proposal's approval", () => {
    const { a, before, created, approved, caused } = fixture();
    const other = ulid(60);
    const otherCreated = a.make(
      "proposal.created",
      other,
      { kind: "strategy", summary: "s", reason: null, payload: {}, source: "mcp" },
      { wall: 6 },
    );
    const otherApproved = a.make("proposal.approved", other, { result: {} }, { wall: 50 });
    const otherVersion = a.make(
      "strategy.versionSaved",
      ulid(4),
      { sha256: "c".repeat(64) },
      { wall: 51, cause: otherApproved.eid },
    );
    const otherFailed = a.make(
      "proposal.applyFailed",
      other,
      { result: { error_code: "write_failed" }, approval: otherApproved.eid },
      { wall: 55 },
    );
    // An applyFailed of the other gid that names this proposal's approval is inert.
    const crossed = a.make(
      "proposal.applyFailed",
      other,
      { result: { error_code: "write_failed" }, approval: approved.eid },
      { wall: 60 },
    );
    const events = [before, created, approved, caused, otherCreated, otherApproved, otherVersion];
    converge([...events, otherFailed, crossed], (store) => {
      expect(versions(store)).toEqual([ulid(1), ulid(2)]);
      expect(
        store
          .read<{ gid: string; status: string }>("SELECT gid, status FROM proposals ORDER BY gid")
          .map((p) => p.status),
      ).toEqual(["approved", "failed"]);
    });
  });

  it("two applyFailed events: the first fails the proposal, both revoke the same version once", () => {
    const { a, before, created, approved, caused, failed, proposal } = fixture();
    const again = a.make(
      "proposal.applyFailed",
      proposal,
      { result: { error_code: "other" }, approval: approved.eid },
      { wall: 45 },
    );
    converge([before, created, approved, caused, failed, again], (store) => {
      expect(versions(store)).toEqual([ulid(1)]);
      expect(store.read<{ result: string }>("SELECT result FROM proposals")[0]?.result).toBe(
        JSON.stringify({ error_code: "write_failed" }),
      );
    });
  });

  it("an approval whose files could not be written revokes its version, in every order", () => {
    const { before, created, approved, caused, failed, proposalRow } = fixture();
    converge([before, created, approved, caused, failed], (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => [v.gid, v.version])).toEqual([
        [ulid(1), 1],
      ]);
      expect(proposalRow(store)).toEqual([
        {
          status: "failed",
          result: JSON.stringify({ error_code: "write_failed" }),
          reviewed_at: "2026-10-31 12:00:00.030000",
        },
      ]);
    });
  });

  it("without the failure the approved version stands", () => {
    const { before, created, approved, caused } = fixture();
    converge([before, created, approved, caused], (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => v.gid)).toEqual([ulid(1), ulid(2)]);
    });
  });

  it("an earlier concurrent rejection wins the decision: the approval's version loses", () => {
    const { before, created, approved, caused, rejected } = fixture();
    converge([before, created, rejected, approved, caused], (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => v.gid)).toEqual([ulid(1)]);
    });
  });

  it("after a winning rejection the failure is a no-op and the note stays", () => {
    const { before, created, approved, caused, failed, rejected, proposalRow } = fixture();
    converge([before, created, rejected, approved, caused, failed], (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => v.gid)).toEqual([ulid(1)]);
      expect(proposalRow(store).map((p) => [p.status, p.result])).toEqual([
        ["rejected", JSON.stringify({ note: "nie teraz" })],
      ]);
    });
  });
});

describe("inv_strategy_versions", () => {
  it("numbers versions in order; a version equal to the current sha is a no-op", () => {
    const store = openTestStore();
    const ev = new Events();
    const r = store.applyEnvelopes([
      ev.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }, { wall: 10 }),
      ev.make("strategy.versionSaved", ulid(2), { sha256: SHA_A }, { wall: 20 }),
      ev.make(
        "strategy.versionSaved",
        ulid(3),
        { sha256: SHA_B, mdText: "# Strategia" },
        { wall: 30 },
      ),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_strategy_versions"]);
    expect(rows(store, "inv_strategy_versions").map((v) => [v.gid, v.version, v.sha256])).toEqual([
      [ulid(1), 1, SHA_A],
      [ulid(3), 2, SHA_B],
    ]);
  });

  it("S1: A, B, revert to A, and a second device's copy of B right after B, in any order", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const events = [
      a.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }, { wall: 10 }),
      a.make("strategy.versionSaved", ulid(2), { sha256: SHA_B }, { wall: 20 }),
      b.make("strategy.versionSaved", ulid(3), { sha256: SHA_B }, { wall: 21 }),
      a.make("strategy.versionSaved", ulid(4), { sha256: SHA_A }, { wall: 30 }),
    ];
    converge(events, (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => [v.gid, v.version])).toEqual([
        [ulid(1), 1],
        [ulid(2), 2],
        [ulid(4), 3],
      ]);
    });
  });
});

describe("inv_rule_runs", () => {
  it("appends every run with its strategy version as named and the report as signal gids", () => {
    const store = openTestStore();
    const ev = new Events();
    const sig = ulid(50);
    store.applyEnvelopes([
      ev.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }),
      ev.make("ruleRun.finished", ulid(2), {
        strategyVersion: ulid(1),
        stats: { rules: 3 },
        report: { new: [sig], escalated: [] },
      }),
      ev.make("ruleRun.finished", ulid(3), { status: "failed", finishedAt: null, errors: ["x"] }),
    ]);
    expect(rows(store, "inv_rule_runs")).toEqual([
      {
        gid: ulid(2),
        trigger: "worker",
        as_of: "2026-03-02",
        status: "ok",
        strategy_version_id: ulid(1),
        stats: { rules: 3 },
        errors: [],
        report: { new: [sig], escalated: [] },
        started_at: "2026-03-02 06:00:00.000000",
        finished_at: "2026-03-02 06:00:05.000000",
      },
      expect.objectContaining({ gid: ulid(3), status: "failed", finished_at: null, errors: ["x"] }),
    ]);
  });
});
