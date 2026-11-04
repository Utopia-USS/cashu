import type { GenesisFiles } from "@cashu/store/genesis";
import { describe, expect, it } from "vitest";
import { MigrationError } from "../contract.js";
import { workspaceClaim } from "./workspace.js";

function files(text: string | Uint8Array | undefined): GenesisFiles {
  return {
    read: (path) =>
      path !== "profiles/synthetic/workspace.json" || text === undefined
        ? undefined
        : typeof text === "string"
          ? new TextEncoder().encode(text)
          : text,
    list: () => [],
  };
}

describe("workspaceClaim (Python profiles/<slug>/workspace.json)", () => {
  it("reads the folder and the routine opt-in as Python does", () => {
    expect(
      workspaceClaim(files('{"path": "/synthetic/ws", "routine_permissions": true}'), "synthetic"),
    ).toEqual({ path: "/synthetic/ws", routinePermissions: true });
    // Only `true` opts in.
    expect(
      workspaceClaim(files('{"path": "/synthetic/ws", "routine_permissions": 1}'), "synthetic"),
    ).toEqual({ path: "/synthetic/ws", routinePermissions: false });
  });

  it("gives the defaults (no native config) where Python falls back to them", () => {
    for (const text of [
      undefined,
      "not json",
      "[]",
      "{}",
      '{"path": ""}',
      '{"path": 5}',
      '﻿{"path": "/synthetic/ws"}',
      new Uint8Array([0xff, 0xfe]),
    ])
      expect(workspaceClaim(files(text), "synthetic")).toBeNull();
  });

  it("refuses a value the native config cannot hold instead of dropping it", () => {
    for (const text of [
      '{"routine_permissions": true}',
      '{"path": "relative/ws"}',
      '{"path": "/synthetic/../ws"}',
      '{"path": "/synthetic/ws/"}',
    ])
      expect(() => workspaceClaim(files(text), "synthetic")).toThrowError(
        new MigrationError("semantic_difference"),
      );
  });
});
