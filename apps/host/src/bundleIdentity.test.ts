import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagedBuildId } from "@cashu/node-host/bundle-identity";
import { afterEach, expect, it, vi } from "vitest";
import { readBundleIdentity, watchBundleIdentity } from "./bundleIdentity.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const { rmSync } = await import("node:fs");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function app(root: string, name: string, version: string) {
  const bundle = join(root, `${name}.app`);
  for (const dir of [
    "Contents/MacOS",
    "Contents/Resources/native",
    "Contents/Resources/skills/workspace-setup",
    "Contents/Resources/connectors",
    "Contents/Resources/renderer",
    "Contents/Library/LaunchAgents",
  ])
    mkdirSync(join(bundle, dir), { recursive: true });
  writeFileSync(join(bundle, "Contents/Info.plist"), `id=${version}`);
  writeFileSync(join(bundle, "Contents/MacOS/cashU"), `binary=${version}`);
  writeFileSync(join(bundle, "Contents/Resources/host.mjs"), "unchanged");
  writeFileSync(join(bundle, "Contents/Resources/shim.mjs"), "shim");
  writeFileSync(join(bundle, "Contents/Resources/native/CashUNotifications.node"), "addon");
  writeFileSync(join(bundle, "Contents/Resources/native/CashUHostService.node"), "service");
  writeFileSync(join(bundle, "Contents/Resources/notify-catalog-v1.json"), "{}");
  writeFileSync(join(bundle, "Contents/Resources/skills/workspace-setup/SKILL.md"), "skill");
  writeFileSync(join(bundle, "Contents/Resources/connectors/README.md"), "catalog");
  writeFileSync(join(bundle, "Contents/Resources/renderer/index.html"), "<html></html>");
  writeFileSync(join(bundle, "Contents/Resources/app.asar"), "asar");
  writeFileSync(join(bundle, "Contents/MacOS/cashu-host-agent"), "agent");
  writeFileSync(
    join(bundle, "Contents/Library/LaunchAgents/io.utopiasoft.cashu.host.plist"),
    "plist",
  );
  const files: Record<string, string> = {};
  for (const [path, content] of [
    ["Contents/Resources/host.mjs", "unchanged"],
    ["Contents/Resources/shim.mjs", "shim"],
    ["Contents/Resources/native/CashUNotifications.node", "addon"],
    ["Contents/Resources/native/CashUHostService.node", "service"],
    ["Contents/Resources/notify-catalog-v1.json", "{}"],
    ["Contents/Resources/skills/workspace-setup/SKILL.md", "skill"],
    ["Contents/Resources/connectors/README.md", "catalog"],
    ["Contents/Resources/renderer/index.html", "<html></html>"],
    ["Contents/Resources/app.asar", "asar"],
    ["Contents/MacOS/cashu-host-agent", "agent"],
    ["Contents/Library/LaunchAgents/io.utopiasoft.cashu.host.plist", "plist"],
  ])
    files[path as string] = createHash("sha256")
      .update(content as string)
      .digest("hex");
  writeFileSync(
    join(bundle, "Contents/Resources/bundle-manifest.json"),
    JSON.stringify({ schema: 1, files }),
  );
  return bundle;
}

it("detects whole bundle replacement when host.mjs stays byte identical", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  const before = readBundleIdentity(bundle);
  const next = app(root, "next", "two");
  renameSync(bundle, join(root, "old.app"));
  renameSync(next, bundle);
  expect(readBundleIdentity(bundle)).not.toEqual(before);
});

it("refuses a missing or mismatched manifest before starting the watch", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  writeFileSync(join(bundle, "Contents/Resources/native/CashUNotifications.node"), "replaced");
  expect(readBundleIdentity(bundle).kind).toBe("invalid");
  expect(() => watchBundleIdentity(bundle, 10, () => undefined)).toThrow(
    "bundle_identity_unavailable",
  );
});

it("rejects modified shipped skills and connector catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const skillsBundle = app(root, "skills", "one");
  writeFileSync(join(skillsBundle, "Contents/Resources/skills/workspace-setup/SKILL.md"), "changed");
  expect(readBundleIdentity(skillsBundle).kind).toBe("invalid");
  const connectorsBundle = app(root, "connectors", "one");
  writeFileSync(join(connectorsBundle, "Contents/Resources/connectors/README.md"), "changed");
  expect(readBundleIdentity(connectorsBundle).kind).toBe("invalid");
});

it("detects path moves and symlink target changes", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const first = app(root, "first", "one");
  const second = app(root, "second", "two");
  const link = join(root, "current.app");
  symlinkSync(first, link);
  const changed = vi.fn();
  const stop = watchBundleIdentity(link, 10, changed);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(link);
  symlinkSync(second, link);
  await vi.advanceTimersByTimeAsync(20);
  expect(changed).toHaveBeenCalledOnce();
  stop();
});

it("restores Electron's ASAR setting after a physical bundle read or refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  const runtime = process as NodeJS.Process & { noAsar?: boolean };
  const hadOwn = Object.hasOwn(runtime, "noAsar");
  const previous = runtime.noAsar;
  try {
    runtime.noAsar = false;
    expect(readBundleIdentity(bundle).kind).toBe("present");
    expect(runtime.noAsar).toBe(false);
    writeFileSync(join(bundle, "Contents/Resources/app.asar"), "tampered");
    expect(readBundleIdentity(bundle).kind).toBe("invalid");
    expect(runtime.noAsar).toBe(false);
  } finally {
    if (hadOwn) runtime.noAsar = previous;
    else Reflect.deleteProperty(runtime, "noAsar");
  }
});

it("bounds the verified content build to the handshake field", () => {
  const digest = "a".repeat(64);
  expect(packagedBuildId("0.0.0", digest)).toBe(`desktop-0.0.0-${digest}`);
  expect(() => packagedBuildId(`0.0.0-${"x".repeat(60)}`, digest)).toThrow(
    "invalid_packaged_build_identity",
  );
});

it("changes content identity for framework bytes and internal link targets", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  const frameworks = join(bundle, "Contents", "Frameworks");
  mkdirSync(frameworks);
  writeFileSync(join(frameworks, "one.dylib"), "one");
  writeFileSync(join(frameworks, "two.dylib"), "two");
  const link = join(frameworks, "Current");
  symlinkSync("one.dylib", link);
  const first = readBundleIdentity(bundle);
  expect(first.kind).toBe("present");
  writeFileSync(join(frameworks, "one.dylib"), "changed");
  const changed = readBundleIdentity(bundle);
  expect(changed.kind).toBe("present");
  if (first.kind === "present" && changed.kind === "present")
    expect(changed.contentDigest).not.toBe(first.contentDigest);
  unlinkSync(link);
  symlinkSync("two.dylib", link);
  const retargeted = readBundleIdentity(bundle);
  expect(retargeted.kind).toBe("present");
  if (changed.kind === "present" && retargeted.kind === "present")
    expect(retargeted.contentDigest).not.toBe(changed.contentDigest);
});

it("refuses escaping, absolute and dangling links anywhere in Contents", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  const frameworks = join(bundle, "Contents", "Frameworks");
  mkdirSync(frameworks);
  const link = join(frameworks, "Current");
  for (const target of ["../../..", root, "/tmp", "missing.dylib"]) {
    symlinkSync(target, link);
    expect(readBundleIdentity(bundle).kind).toBe("invalid");
    unlinkSync(link);
  }
});

it("watches framework changes outside Resources", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "cashu-bundle-"));
  roots.push(root);
  const bundle = app(root, "cashU", "one");
  const framework = join(bundle, "Contents", "Frameworks", "library.dylib");
  mkdirSync(join(bundle, "Contents", "Frameworks"));
  writeFileSync(framework, "one");
  const changed = vi.fn();
  const stop = watchBundleIdentity(bundle, 10, changed);
  writeFileSync(framework, "two");
  await vi.advanceTimersByTimeAsync(20);
  expect(changed).toHaveBeenCalledOnce();
  stop();
});
