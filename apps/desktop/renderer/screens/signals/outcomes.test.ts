import { afterEach, expect, it, vi } from "vitest";
import {
  type FailedOutcome,
  groupNotice,
  groupRefusal,
  guardedNotice,
  thrownNotice,
} from "./outcomes.js";

afterEach(() => vi.restoreAllMocks());

it("maps a guarded command that did not complete to one notice", () => {
  expect(guardedNotice({ kind: "outcome_unknown" } as FailedOutcome)).toBe("unknown");
  expect(guardedNotice({ kind: "not_started", reason: "offline" })).toBe("unavailable");
  expect(guardedNotice({ kind: "previous_completed" })).toBe("previous_completed");
  expect(guardedNotice({ kind: "previous_refused" })).toBe("previous_refused");
  expect(guardedNotice({ kind: "refused", reason: "no_signal" })).toBe("failed");
});

it("maps a group save to its notice and carries the refusal of a partial or refused save", () => {
  expect(groupNotice({ status: "saved", decisions: ["a"] })).toBe("saved");
  expect(groupNotice({ status: "skipped", decisions: [] })).toBe("skipped");
  expect(groupNotice({ status: "unavailable", decisions: [] })).toBe("unavailable");
  const partial = { status: "partial", decisions: ["a"], reason: "no_signal" } as const;
  expect(groupNotice(partial)).toBe("partial");
  expect(groupRefusal(partial)).toBe("no_signal");
  const refused = { status: "refused", decisions: [], reason: "scope_changed" } as const;
  expect(groupNotice(refused)).toBe("failed");
  expect(groupRefusal(refused)).toBe("scope_changed");
  expect(groupRefusal({ status: "unknown", decisions: [] })).toBeNull();
});

it("logs only the class and code of a thrown write, never its message", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = Object.assign(new Error("quantity 12.5 for synthetic note"), { code: "conflict" });
  expect(thrownNotice("decision", error)).toBe("unknown");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("decision"), "Error:conflict");
  expect(thrownNotice("undo", new TypeError("synthetic 99.00"))).toBe("unknown");
  expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("undo"), "TypeError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic");
});
