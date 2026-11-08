import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { NativeVaultSession } from "../nativeVault.js";
import type { OpenVault } from "../stores.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";
import { WorkspacePathError } from "./files.js";
import { createProductionWorkspaceProvider } from "./production.js";
import { createProductionPublication } from "./publication.js";
import { createResearchWorkspaceInfo } from "./researchInfo.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-workspace-production-")));
  roots.push(root);
  const workspace = join(root, "home", "Documents", "cashU", "synthetic");
  const config = join(root, "data", "workspace", "v1", `${"a".repeat(32)}.json`);
  const skillSource = join(root, "assets", "skills");
  mkdirSync(join(skillSource, "workspace-setup"), { recursive: true });
  writeFileSync(
    join(skillSource, "workspace-setup", "SKILL.md"),
    "---\nname: workspace-setup\ndescription: |\n  Applicability - POSITIVE: synthetic.\n  Applicability - NEGATIVE: NOT other.\n---\n\nsynthetic skill\n",
  );
  let current = true;
  const io = createProductionPublication({
    workspace,
    config,
    skillSource,
    isCurrent: () => current,
  });
  return {
    root,
    workspace,
    config,
    skillSource,
    io,
    revoke: () => {
      current = false;
    },
  };
}

test("publishes workspace and private config only in the exact scoped roots", () => {
  const f = fixture();
  f.io.ensureDirectory(f.workspace);
  f.io.writeText(join(f.workspace, "CLAUDE.md"), "synthetic\n");
  f.io.writeText(f.config, "{}\n", 0o600);
  expect(f.io.readText(join(f.workspace, "CLAUDE.md"), 100)).toBe("synthetic\n");
  expect(readFileSync(f.config, "utf8")).toBe("{}\n");
  expect(() => f.io.kind(join(f.root, "outside"))).toThrowError(
    new WorkspacePathError("outside_capability"),
  );
  f.revoke();
  expect(() => f.io.writeText(join(f.workspace, "CLAUDE.md"), "changed")).toThrowError(
    new WorkspacePathError("stale_capability"),
  );
});

test("refuses symlinks, hardlinks, oversized reads and replaced workspace root", () => {
  const f = fixture();
  f.io.ensureDirectory(f.workspace);
  const target = join(f.workspace, "CLAUDE.md");
  f.io.writeText(target, "synthetic");
  linkSync(target, join(f.workspace, "hard"));
  expect(() => f.io.readText(target, 100)).toThrowError(new WorkspacePathError("unsafe_read"));
  expect(() => f.io.writeText(target, "changed")).toThrowError(
    new WorkspacePathError("path_replaced"),
  );
  symlinkSync(target, join(f.workspace, "link"));
  expect(() => f.io.readText(join(f.workspace, "link"), 100)).toThrow();
  expect(() => f.io.readText(target, 1024 * 1024 + 1)).toThrowError(
    new WorkspacePathError("unsafe_read"),
  );
  // Move the old folder away before creating the new one, so the file system cannot hand the new
  // folder the old one's inode (Linux reuses a freed inode at once).
  renameSync(f.workspace, `${f.workspace}.replaced`);
  mkdirSync(f.workspace);
  expect(() => f.io.writeText(join(f.workspace, "CLAUDE.md"), "changed")).toThrowError(
    new WorkspacePathError("path_replaced"),
  );
});

test("skill copy refuses source links and publishes checked content", () => {
  const f = fixture();
  f.io.ensureDirectory(f.workspace);
  const dest = join(f.workspace, ".claude", "skills", "workspace-setup");
  f.io.copySkill("workspace-setup", dest);
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("synthetic skill\n");
  symlinkSync(join(f.root, "outside"), join(f.skillSource, "workspace-setup", "linked"));
  expect(() => f.io.copySkill("workspace-setup", dest)).toThrowError(
    new WorkspacePathError("path_replaced"),
  );
});

test("production provider binds one current native vault and refuses wrong vault and stale authority", async () => {
  const f = fixture();
  const vault = "a".repeat(32);
  const home = join(f.root, "home");
  const workspacesRoot = join(home, "Documents", "cashU");
  const dataRoot = join(f.root, "data");
  const sourceRoot = join(f.root, "legacy-source");
  let current = true;
  let privacy = "strict";
  const native = {
    id: vault,
    workspaceAuthority: () =>
      current ? { vault, generation: "session-one", isCurrent: () => current } : null,
    store: {
      read: (sql: string) =>
        sql.includes("FROM profiles") ? [{ slug: "synthetic", baseCurrency: "PLN", privacy }] : [],
    },
  } as unknown as NativeVaultSession;
  const entry = {
    vaultId: vault,
    deviceId: "b".repeat(32),
    vaultRoot: join(dataRoot, "native", vault),
    state: "ready",
    enrollment: "creator",
  } as const satisfies NativeVaultInventoryEntry;
  const inventory: NativeVaultInventoryEntry[] = [entry];
  const provider = createProductionWorkspaceProvider({
    dataRoot,
    home,
    workspacesRoot,
    skillSource: f.skillSource,
    protectedRoots: [sourceRoot],
    version: "synthetic",
    program: { command: "/synthetic/cashu", args: [] },
    sessions: (id) => (id === vault ? native : null),
    inventory: () => inventory,
    now: () => new Date("2026-11-04T00:00:00Z"),
  });
  expect(provider.bind("b".repeat(32))).toBeNull();
  const binding = provider.bind(vault);
  expect(binding?.generation).toBe("session-one");
  const input = { slug: "synthetic", privacy: "strict" as const, baseCurrency: "PLN", modules: [] };
  expect(await binding?.inspect(input)).toMatchObject({ availability: "ready", path: f.workspace });
  const open = { id: vault, mode: "native", store: native.store } as OpenVault;
  const source = createResearchWorkspaceInfo({
    provider,
    vaults: new Map([[vault, open]]),
    isCurrent: () => current,
  });
  const read = ((sql: string) =>
    sql === "SELECT gid FROM profiles" ? [{ gid: vault }] : []) as never;
  await source.refresh(vault);
  expect(source.source.current(read)).toMatchObject({
    status: "current",
    value: { value: { path: f.workspace, exists: false } },
  });
  expect(await binding?.apply(input)).toMatchObject({ kind: "completed" });
  expect(source.source.current(read)).toMatchObject({ status: "unavailable" });
  await source.refresh(vault);
  expect(source.source.current(read)).toMatchObject({
    status: "current",
    value: { value: { path: f.workspace, exists: true, skillInstalled: false } },
  });
  source.close();
  expect(readFileSync(join(f.workspace, "CLAUDE.md"), "utf8")).toContain("cashU agent workspace");
  privacy = "amounts";
  expect(binding?.isCurrent()).toBe(false);
  privacy = "strict";
  expect(binding?.isCurrent()).toBe(false);
  const refreshed = provider.bind(vault);
  expect(await refreshed?.apply({ ...input, path: dataRoot })).toMatchObject({
    kind: "refused",
    code: "path_data_dir",
  });
  expect(await refreshed?.apply({ ...input, path: sourceRoot })).toMatchObject({
    kind: "refused",
    code: "path_data_dir",
  });
  const other = {
    ...entry,
    vaultId: "c".repeat(32),
    vaultRoot: join(f.root, "external-native", "c".repeat(32)),
  };
  inventory.push(other);
  const otherConfig = join(dataRoot, "workspace", "v1", `${other.vaultId}.json`);
  writeFileSync(otherConfig, "{invalid", { mode: 0o600 });
  expect(refreshed?.isCurrent()).toBe(false);
  expect(provider.bind(vault)).toBeNull();
  writeFileSync(
    otherConfig,
    JSON.stringify({ format: 1, vaultId: other.vaultId, path: f.workspace }),
  );
  expect(provider.bind(vault)).toBeNull();
  writeFileSync(
    otherConfig,
    JSON.stringify({
      format: 1,
      vaultId: other.vaultId,
      path: f.workspace,
      routinePermissions: false,
    }),
  );
  expect(await provider.bind(vault)?.apply({ ...input, path: other.vaultRoot })).toMatchObject({
    kind: "refused",
    code: "path_data_dir",
  });
  expect(await provider.bind(vault)?.apply(input)).toMatchObject({
    kind: "refused",
    code: "workspace_taken",
  });
  inventory.pop();
  current = false;
  expect(await binding?.apply(input)).toMatchObject({ kind: "refused", code: "stale_capability" });
});

test("production provider publishes and inspects a workspace at a chosen folder", async () => {
  const f = fixture();
  const vault = "a".repeat(32);
  const home = join(f.root, "home");
  const dataRoot = join(f.root, "data");
  const chosen = join(home, "Projects", "synthetic-workspace");
  const native = {
    id: vault,
    workspaceAuthority: () => ({ vault, generation: "session-one", isCurrent: () => true }),
    store: {
      read: (sql: string) =>
        sql.includes("FROM profiles")
          ? [{ slug: "synthetic", baseCurrency: "PLN", privacy: "strict" }]
          : [],
    },
  } as unknown as NativeVaultSession;
  const entry = {
    vaultId: vault,
    deviceId: "b".repeat(32),
    vaultRoot: join(dataRoot, "native", vault),
    state: "ready",
    enrollment: "creator",
  } as const satisfies NativeVaultInventoryEntry;
  const provider = createProductionWorkspaceProvider({
    dataRoot,
    home,
    workspacesRoot: join(home, "Documents", "cashU"),
    skillSource: f.skillSource,
    version: "synthetic",
    program: { command: "/synthetic/cashu", args: [] },
    sessions: (id) => (id === vault ? native : null),
    inventory: () => [entry],
    now: () => new Date("2026-11-04T00:00:00Z"),
  });
  const input = { slug: "synthetic", privacy: "strict" as const, baseCurrency: "PLN", modules: [] };
  expect(await provider.bind(vault)?.apply({ ...input, path: chosen })).toMatchObject({
    kind: "completed",
    status: { availability: "ready", path: chosen, custom: true, exists: true, folderExists: true },
  });
  expect(await provider.bind(vault)?.inspect(input)).toMatchObject({
    availability: "ready",
    path: chosen,
    configured: true,
    exists: true,
  });
  expect(readFileSync(join(chosen, "CLAUDE.md"), "utf8")).toContain("cashU agent workspace");
});
