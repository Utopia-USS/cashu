import { expect, it, vi } from "vitest";
import { mcpFileHome, mcpNamedHome } from "./homes.js";

it("uses captured macOS account lookup without a shell, including option-like names", () => {
  const lookup = vi.fn(() => "synthetic:*:1:1::0:0:Synthetic:/synthetic/home:/bin/sh\n");
  expect(mcpNamedHome("-synthetic", {}, "darwin", lookup)).toBe("/synthetic/home");
  expect(lookup).toHaveBeenCalledWith("/usr/bin/id", ["-P", "--", "-synthetic"]);
});
it("uses Linux NSS by name and refuses numeric UID fallback", () => {
  const lookup = vi.fn(() => "synthetic:x:123:123::/synthetic/home:/bin/sh\n");
  expect(mcpNamedHome("synthetic", {}, "linux", lookup)).toBe("/synthetic/home");
  expect(lookup).toHaveBeenCalledWith("/usr/bin/getent", ["--", "passwd", "synthetic"]);
  expect(mcpNamedHome("123", {}, "linux", lookup)).toBeUndefined();
  lookup.mockImplementation(() => {
    throw new Error("lookup failed");
  });
  expect(mcpNamedHome("unknown", {}, "linux", lookup)).toBeUndefined();
});
it("matches Windows USERPROFILE and ntpath named-user rules", () => {
  const env = { HOME: "ignored", USERPROFILE: "C:\\Users\\synthetic", USERNAME: "synthetic" };
  expect(mcpFileHome(env, "win32")).toBe("C:\\Users\\synthetic");
  expect(mcpNamedHome("synthetic", env, "win32")).toBe("C:\\Users\\synthetic");
  expect(mcpNamedHome("other", env, "win32")).toBe("C:\\Users\\other");
  expect(mcpNamedHome("other", { ...env, USERPROFILE: "C:\\custom" }, "win32")).toBeUndefined();
  expect(mcpFileHome({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\synthetic" }, "win32")).toBe(
    "C:\\Users\\synthetic",
  );
  expect(mcpFileHome({ HOME: "ignored" }, "win32")).toBeUndefined();
});
