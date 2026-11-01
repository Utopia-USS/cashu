// Export copies kept only until an import is decided are pruned (F5 R9): abandoned preview uploads
// after a day, proposal exports once no pending proposal references them. Translates
// tests/investments/persistence/test_invp_staging_prune.py (the holding area is an in-memory fake of
// the port; committed archives live in the blob store and are never listed here). Synthetic data only.
import { describe, expect, it } from "vitest";
import { applyRaw, rawGid, vault } from "../commands/testing/fixtures.js";
import type { Read } from "../queries/shared.js";
import {
  type PruneReport,
  prune,
  pruneQuietly,
  referencedStagedFiles,
  type StagedEntry,
  type StagingArea,
} from "./staging.js";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const file = (c: string) => `${c.repeat(64)}.csv`;

/** One profile's layout: old / fresh uploads, a pending proposal's export, orphaned exports. */
function layout() {
  const entries = new Map<string, StagedEntry>();
  const add = (key: string, folder: StagedEntry["folder"], name: string, age: number) =>
    entries.set(key, { folder, name, kind: "file", modifiedMs: NOW - age });
  add("old_upload", "staging", file("a"), 2 * DAY);
  add("fresh_upload", "staging", file("b"), 60_000);
  add("pending_export", "proposals", file("c"), 30 * DAY);
  add("rejected_export", "proposals", file("d"), 2 * 3600 * 1000);
  add("fresh_orphan", "proposals", file("e"), 60_000);
  const area: StagingArea = {
    list: () => [...entries.values()],
    remove: (entry) => {
      for (const [k, e] of entries) if (e === entry) entries.delete(k);
    },
  };
  const v = vault();
  const proposal = (n: number, blob: string, status: "pending" | "failed") => {
    const g = rawGid(n);
    const [sha256, ext] = blob.split(".");
    applyRaw(v, [
      {
        type: "proposal.created",
        gid: g,
        data: {
          kind: "import",
          summary: "Import",
          reason: null,
          payload: { blob: { sha256, ext } },
          source: "agent",
        },
      },
      ...(status === "failed" ? [{ type: "proposal.failed", gid: g, data: { result: {} } }] : []),
    ]);
  };
  proposal(1, file("c"), "pending");
  proposal(2, file("d"), "failed");
  const alive = () => new Set(entries.keys());
  return { area, alive, v, read: v.store.read.bind(v.store) as Read };
}

const stats = (r: PruneReport) => ({ removed: r.removed, kept: r.kept, errors: r.errors });

describe("staging prune (test_invp_staging_prune.py)", () => {
  it("test_prune_removes_abandoned_uploads_and_unreferenced_exports", () => {
    const l = layout();
    const report = pruneQuietly(l.area, () => [l.read], NOW);
    expect(l.alive()).toEqual(new Set(["fresh_upload", "pending_export", "fresh_orphan"]));
    expect(stats(report)).toEqual({ removed: 2, kept: 3, errors: 0 });
    expect(pruneQuietly(l.area, () => [l.read], NOW).removed).toBe(0); // idempotent
  });

  it("test_prune_keeps_every_proposal_export_when_proposals_cannot_be_listed", () => {
    const l = layout();
    pruneQuietly(
      l.area,
      () => {
        throw new Error("database is locked");
      },
      NOW,
    );
    for (const k of ["pending_export", "rejected_export", "fresh_orphan"]) {
      expect(l.alive().has(k)).toBe(true);
    }
    expect(l.alive().has("old_upload")).toBe(false); // uploads only depend on their age
  });

  it("only pending import proposals reference a staged file", () => {
    const l = layout();
    expect(referencedStagedFiles(l.read)).toEqual(new Set([file("c")]));
  });

  it("never follows a symlink or a directory and counts a failing removal", () => {
    const entries: StagedEntry[] = [
      { folder: "staging", name: "link", kind: "symlink", modifiedMs: 0 },
      { folder: "staging", name: "dir", kind: "dir", modifiedMs: 0 },
      { folder: "staging", name: file("a"), kind: "file", modifiedMs: 0 },
    ];
    const area: StagingArea = {
      list: () => entries,
      remove: () => {
        throw new Error("permission denied");
      },
    };
    expect(stats(prune(area, new Set(), NOW))).toEqual({ removed: 0, kept: 0, errors: 1 });
  });
});
