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

it("logs a thrown write locally instead of swallowing it", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = new Error("synthetic");
  expect(thrownNotice("decision", error)).toBe("unknown");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("decision"), error);
});
