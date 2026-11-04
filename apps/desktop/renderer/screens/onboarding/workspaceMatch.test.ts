import { expect, it } from "vitest";
import { workspaceMatches } from "./workspaceMatch.js";

it("does not treat a healthy old workspace as proof of a different requested path or permissions", () => {
  const old = {
    availability: "ready" as const,
    path: "/tmp/old-workspace",
    defaultPath: "/tmp/default-workspace",
    configured: true,
    upToDate: true,
    routinePermissions: true,
  };
  expect(workspaceMatches(old, { path: "/tmp/new-workspace", routinePermissions: false })).toBe(
    false,
  );
  expect(workspaceMatches(old, { path: old.path, routinePermissions: false })).toBe(false);
  expect(workspaceMatches(old, { path: old.path, routinePermissions: true })).toBe(true);
});
