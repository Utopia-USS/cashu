import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundlePathFromEntry,
  packagedBuildId,
  packagedLayout,
  packagedVersion,
  readBundleIdentity,
  watchBundleIdentity,
} from "./bundleIdentity.js";
import { linkFile } from "./testing/links.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const WIN = "win32" as const;

/** The resources of a synthetic Windows install (install-relative, forward slashes). */
function resources(version: string): Record<string, string> {
  return {
    "resources/host.mjs": "host",
    "resources/shim.mjs": "shim",
    "resources/notify-catalog-v1.json": "{}",
    "resources/skills/workspace-setup/SKILL.md": "skill",
    "resources/connectors/README.md": "catalog",
    "resources/renderer/index.html": "<html></html>",
    "resources/app.asar": "asar",
    "resources/node_modules/zod/index.js": "module",
    "resources/app-identity.json": `${JSON.stringify({ schema: 1, bundleId: "io.utopiasoft.cashu", version })}\n`,
  };
}

/**
 * A synthetic install dir as package-windows.mjs lays it out: cashU.exe and Electron's files at the
 * root, everything of the app under resources/, a manifest over every resource file but itself.
 */
function install(
  options: {
    readonly version?: string;
    readonly listed?: Record<string, string>;
    readonly unlisted?: Record<string, string>;
    readonly manifest?: (files: Record<string, string>) => unknown;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "cashu-win-install-"));
  roots.push(root);
  const dir = join(root, "cashU");
  const listed = { ...resources(options.version ?? "1.2.3"), ...options.listed };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  for (const [path, content] of Object.entries({ ...listed, ...options.unlisted }))
    write(path, content);
  write("cashU.exe", "binary");
  write("ffmpeg.dll", "codec");
  write("locales/en-US.pak", "locale");
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(listed)) files[path] = sha(content);
  write(
    "resources/bundle-manifest.json",
    JSON.stringify(options.manifest ? options.manifest(files) : { schema: 1, files }),
  );
  return dir;
}

describe("Windows install identity", () => {
  it("verifies a complete install and binds its canonical path", () => {
    const dir = install();
    const identity = readBundleIdentity(dir, WIN);
    expect(identity.kind).toBe("present");
    if (identity.kind !== "present") return;
    expect(identity.canonicalPath).toBe(realpathSync.native(dir));
    expect(identity.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readBundleIdentity(dir, WIN)).toEqual(identity);
    expect(
      packagedBuildId(packagedVersion(identity.canonicalPath, WIN), identity.contentDigest),
    ).toBe(`desktop-1.2.3-${identity.contentDigest}`);
  });

  it("lays out resources and executable and finds the install of an entry", () => {
    const dir = install();
    expect(packagedLayout(dir, WIN)).toEqual({
      resources: join(dir, "resources"),
      executable: join(dir, "cashU.exe"),
    });
    expect(packagedLayout("/x/cashU.app", "darwin")).toEqual({
      resources: join("/x/cashU.app", "Contents", "Resources"),
      executable: join("/x/cashU.app", "Contents", "MacOS", "cashU"),
    });
    expect(bundlePathFromEntry(join(dir, "resources", "host.mjs"), WIN)).toBe(dir);
    expect(bundlePathFromEntry(join(dir, "resources", "renderer", "index.html"), WIN)).toBe(
      undefined,
    );
    expect(bundlePathFromEntry(join(dir, "host.mjs"), WIN)).toBeUndefined();
    const macEntry = join("/x", "cashU.app", "Contents", "Resources", "host.mjs");
    // NTFS names are case-insensitive: any case of `resources` is the resources dir.
    expect(bundlePathFromEntry(join(dir, "RESOURCES", "host.mjs"), WIN)).toBe(dir);
    // The macOS rule is unchanged and never matches a Windows install.
    expect(bundlePathFromEntry(macEntry, "darwin")).toBe(join("/x", "cashU.app"));
    expect(bundlePathFromEntry(join(dir, "resources", "host.mjs"), "darwin")).toBeUndefined();
  });

  it("refuses an install whose manifest misses, adds or misnames a resource", () => {
    const bad = [
      // A required resource is not listed (and so its file is unlisted too).
      install({ manifest: ({ "resources/app.asar": _, ...files }) => ({ schema: 1, files }) }),
      // A resource on disk the manifest does not list.
      install({ unlisted: { "resources/extra.js": "planted" } }),
      // A key outside resources/ (cashU.exe is covered by the content digest, not the manifest).
      install({
        manifest: (files) => ({ schema: 1, files: { ...files, "cashU.exe": sha("binary") } }),
      }),
      // The manifest lists itself.
      install({
        manifest: (files) => ({
          schema: 1,
          files: { ...files, "resources/bundle-manifest.json": sha("x") },
        }),
      }),
      // Backslash and dot segments are never keys.
      install({
        manifest: (files) => ({
          schema: 1,
          files: { ...files, "resources\\host.mjs": sha("host") },
        }),
      }),
      install({
        manifest: (files) => ({
          schema: 1,
          files: { ...files, "resources/../cashU.exe": sha("binary") },
        }),
      }),
      // Unknown manifest fields and schema.
      install({ manifest: (files) => ({ schema: 2, files }) }),
      install({ manifest: (files) => ({ schema: 1, files, extra: true }) }),
    ];
    for (const dir of bad) expect(readBundleIdentity(dir, WIN).kind).toBe("invalid");
  });

  it("refuses tampered resources, a malformed identity record and a missing executable", () => {
    const asar = install();
    writeFileSync(join(asar, "resources", "app.asar"), "tampered");
    expect(readBundleIdentity(asar, WIN).kind).toBe("invalid");
    const identity = install();
    writeFileSync(join(identity, "resources", "app-identity.json"), "{}");
    expect(readBundleIdentity(identity, WIN).kind).toBe("invalid");
    // Listed and hashed, but not the exact identity shape.
    const shape = install({
      listed: { "resources/app-identity.json": JSON.stringify({ schema: 1, version: "1.0.0" }) },
    });
    expect(readBundleIdentity(shape, WIN).kind).toBe("invalid");
    const executable = install();
    unlinkSync(join(executable, "cashU.exe"));
    expect(readBundleIdentity(executable, WIN).kind).toBe("invalid");
    expect(readBundleIdentity(join(executable, "missing"), WIN).kind).toBe("invalid");
  });

  it("never verifies one platform's layout as the other's", () => {
    expect(readBundleIdentity(install(), "darwin").kind).toBe("invalid");
    const app = join(install(), "..", "cashU.app");
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    expect(readBundleIdentity(app, WIN).kind).toBe("invalid");
  });

  it("changes the content digest for Electron's files outside resources and the version", () => {
    const dir = install();
    const first = readBundleIdentity(dir, WIN);
    writeFileSync(join(dir, "ffmpeg.dll"), "other codec");
    const changed = readBundleIdentity(dir, WIN);
    expect(first.kind === "present" && changed.kind === "present").toBe(true);
    if (first.kind === "present" && changed.kind === "present") {
      expect(changed.contentDigest).not.toBe(first.contentDigest);
      expect(changed.fingerprint).not.toBe(first.fingerprint);
    }
    const next = readBundleIdentity(install({ version: "1.2.4" }), WIN);
    expect(next.kind === "present" && first.kind === "present").toBe(true);
    if (next.kind === "present" && first.kind === "present")
      expect(next.contentDigest).not.toBe(first.contentDigest);
  });

  it("reports a changed install to the watcher", async () => {
    vi.useFakeTimers();
    const dir = install();
    const changed = vi.fn();
    const stop = watchBundleIdentity(dir, 10, changed, WIN);
    await vi.advanceTimersByTimeAsync(20);
    expect(changed).not.toHaveBeenCalled();
    writeFileSync(join(dir, "ffmpeg.dll"), "replaced");
    await vi.advanceTimersByTimeAsync(20);
    expect(changed).toHaveBeenCalledOnce();
    stop();
    const broken = install();
    unlinkSync(join(broken, "cashU.exe"));
    expect(() => watchBundleIdentity(broken, 10, () => undefined, WIN)).toThrow(
      "bundle_identity_unavailable",
    );
  });

  // File symlinks; on a Windows runner without the privilege to create them the test skips itself.
  // Node reports junctions as links too, so the same refusals apply to them.
  it("refuses escaping, absolute and dangling links anywhere in the install", ({ skip }) => {
    const dir = install();
    const link = join(dir, "locales", "link.pak");
    for (const target of ["../..", "/tmp", "missing.pak"]) {
      linkFile(target, link, skip);
      expect(readBundleIdentity(dir, WIN).kind).toBe("invalid");
      unlinkSync(link);
    }
    linkFile("en-US.pak", link, skip);
    expect(readBundleIdentity(dir, WIN).kind).toBe("present");
  });
});
