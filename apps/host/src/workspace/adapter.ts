import { dirname, join, resolve, sep } from "node:path";
import { pyCasefold } from "@cashu/domain";
import {
  denyRules,
  mcpCommandStale,
  mergeClaudeMd,
  mergeMcp,
  mergeSettings,
  outdatedItems,
  planSkills,
  renderSections,
  routineOwned,
  type SkillRecord,
  type SkillSource,
  skillStates,
  userPart,
  type WorkspaceContentContext,
  type WorkspaceRenderContext,
  type WorkspaceSnapshot,
  wantedSkills,
} from "@cashu/domain/core/workspace";
import { type CheckedPathPolicy, checkWorkspacePath, WorkspacePathError } from "./files.js";
import type {
  WorkspaceApplyInput,
  WorkspaceApplyResult,
  WorkspaceBinding,
  WorkspaceInspectInput,
  WorkspaceProvider,
  WorkspaceStatus,
} from "./index.js";
import { runWorkspaceOperation, type WorkspaceStep } from "./operations.js";

const VAULT = /^[0-9a-f]{32}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FOLDERS = ["notes", "research", "scripts", "connectors", "inbox"] as const;
const MANIFEST = ".claude/cashu-workspace.json";
const LEGACY_MANIFEST = ".claude/finanse-workspace.json";
const SETTINGS = ".claude/settings.json";
const SKILL_ROOT = ".claude/skills";
const ACTIVE_VAULTS = new Set<string>();
const ACTIVE_PATHS = new Set<string>();
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
const samePath = (a: string, b: string): boolean =>
  pyCasefold(a.normalize("NFC")) === pyCasefold(b.normalize("NFC"));
const truthyObject = (value: Json | null): boolean =>
  value !== null && Object.keys(value).length > 0;

/** These operations must be granted only for the checked workspace and private config root. */
export interface WorkspacePublication {
  kind(path: string): "missing" | "file" | "directory" | "symlink" | "other";
  readText(path: string, maxBytes: number): string | null;
  skillHash(path: string): string | null;
  readLink(path: string): string | null;
  ensureDirectory(path: string, mode?: number): void;
  writeText(path: string, text: string, mode?: number): void;
  backup(from: string, to: string): void;
  copySkill(sourceName: string, to: string): void;
  removeSkill(path: string): void;
  createLink(path: string, target: string): void;
  removeFile(path: string): void;
}

export interface WorkspaceVaultAuthority {
  readonly vault: string;
  readonly generation: string;
  readonly slug: string;
  readonly version: string;
  readonly modules: WorkspaceContentContext["modules"];
  readonly privacy: "strict" | "amounts";
  readonly baseCurrency: string;
  readonly dataRoot: string;
  readonly defaultPath: string;
  readonly policy: CheckedPathPolicy;
  readonly shipped: ReadonlyMap<string, SkillSource>;
  readonly skillsSourceAvailable: boolean;
  readonly invocation: WorkspaceContentContext["invocation"] | null;
  readonly cli: readonly string[] | null;
  readonly tools: WorkspaceContentContext["tools"] | null;
  readonly protected: readonly string[];
  readonly publication: WorkspacePublication;
  /** Production binds publication to the canonical target selected for this operation. */
  publicationFor?(path: string): WorkspacePublication;
  /** Updates the complete host claim inventory after the private config is published. */
  recordConfiguredPath(path: string): void;
  isCurrent(): boolean;
  now(): string;
  stamp(): string;
}

export interface WorkspaceAuthoritySource {
  bind(vault: string): WorkspaceVaultAuthority | null;
}

type Json = Record<string, unknown>;
const dict = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const skillRecords = (value: unknown): Record<string, SkillRecord> => {
  const entries = Object.entries(dict(value));
  if (entries.some(([name]) => !/^[a-z][a-z0-9-]*$/.test(name)))
    throw new WorkspacePathError("invalid_manifest");
  return Object.fromEntries(
    entries
      .filter(([, row]) => typeof dict(row).version === "string")
      .map(([name, row]) => [
        name,
        {
          module: typeof dict(row).module === "string" ? (dict(row).module as string) : "core",
          version: dict(row).version as string,
        },
      ]),
  );
};
const previous = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((r): r is string => typeof r === "string") : [];
const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((row, index) => same(row, b[index]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = dict(a),
      right = dict(b),
      keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
    );
  }
  return false;
};
const quoted = (s: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) && s ? s : `'${s.replaceAll("'", `'"'"'`)}'`;
const command = (path: string, prompt?: string): string =>
  `cd ${quoted(path)} && claude${prompt ? ` -p ${quoted(prompt)}` : ""}`;

function readJson(io: WorkspacePublication, path: string): { value: Json | null; valid: boolean } {
  if (io.kind(path) === "missing") return { value: null, valid: true };
  try {
    const text = io.readText(path, 1024 * 1024);
    if (text === null) return { value: null, valid: false };
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { value, valid: true }
      : { value: null, valid: false };
  } catch {
    return { value: null, valid: false };
  }
}

function requireAuthority(authority: WorkspaceVaultAuthority, input: WorkspaceInspectInput): void {
  if (!VAULT.test(authority.vault) || !SLUG.test(authority.slug) || input.slug !== authority.slug)
    throw new WorkspacePathError("invalid_profile");
  if (
    !same(input.modules, authority.modules) ||
    input.privacy !== authority.privacy ||
    input.baseCurrency !== authority.baseCurrency
  )
    throw new WorkspacePathError("stale_context");
  if (!authority.isCurrent()) throw new WorkspacePathError("stale_capability");
}

function configPath(authority: WorkspaceVaultAuthority): string {
  if (!VAULT.test(authority.vault)) throw new WorkspacePathError("invalid_vault");
  return join(authority.dataRoot, "workspace", "v1", `${authority.vault}.json`);
}

function configured(authority: WorkspaceVaultAuthority): { path: string | null; routine: boolean } {
  const config = readJson(authority.publication, configPath(authority)).value;
  if (config?.format !== 1 || config.vaultId !== authority.vault)
    return { path: null, routine: false };
  return {
    path: typeof config.path === "string" && config.path ? config.path : null,
    routine: config.routinePermissions === true,
  };
}

function manifestAt(
  authority: WorkspaceVaultAuthority,
  path: string,
): { value: Json | null; valid: boolean; legacy: boolean } {
  const io = authority.publication;
  const current = readJson(io, join(path, MANIFEST));
  return { ...current, legacy: io.kind(join(path, LEGACY_MANIFEST)) !== "missing" };
}

function targetContext(
  authority: WorkspaceVaultAuthority,
  path: string,
  routine: boolean,
): WorkspaceRenderContext | null {
  if (!authority.invocation || !authority.cli || !authority.tools) return null;
  return {
    slug: authority.slug,
    version: authority.version,
    path,
    protected: authority.protected,
    modules: authority.modules,
    tools: authority.tools,
    invocation: authority.invocation,
    routinePermissions: routine,
    privacy: authority.privacy,
    baseCurrency: authority.baseCurrency,
    skills: wantedSkills(
      authority.modules.map((m) => m.id),
      authority.shipped,
    ),
    researchAvailable: authority.shipped.has("market-research"),
    cli: authority.cli,
  };
}

function linkState(
  io: WorkspacePublication,
  path: string,
  target: string,
  failed: readonly string[],
): "ok" | "missing" | "unsupported" | "conflict" {
  const kind = io.kind(path);
  if (kind === "symlink") {
    const actual = io.readLink(path);
    return actual &&
      (actual === target ||
        samePath(resolve(dirname(path), actual), resolve(dirname(path), target)))
      ? "ok"
      : "conflict";
  }
  if (kind !== "missing") return "conflict";
  return failed.includes(path.endsWith("AGENTS.md") ? "AGENTS.md" : ".agents/skills")
    ? "unsupported"
    : "missing";
}

function snapshot(
  authority: WorkspaceVaultAuthority,
  path: string,
  manifest: Json,
  ctx: WorkspaceRenderContext,
  legacy: boolean,
): WorkspaceSnapshot {
  const io = authority.publication;
  const managed = skillRecords(manifest.skills);
  const actual: Record<string, string | null> = {};
  for (const name of new Set([...ctx.skills.map((s) => s.name), ...Object.keys(managed)])) {
    const target = join(path, SKILL_ROOT, name);
    actual[name] = io.kind(target) === "missing" ? null : (io.skillHash(target) ?? "");
  }
  const failed = previous(manifest.links_failed);
  return {
    folders: Object.fromEntries(
      FOLDERS.map((folder) => [folder, io.kind(join(path, folder)) === "directory"]),
    ),
    claudeMd: io.readText(join(path, "CLAUDE.md"), 1024 * 1024),
    mcp: readJson(io, join(path, ".mcp.json")),
    settings: readJson(io, join(path, SETTINGS)),
    links: {
      "AGENTS.md": linkState(io, join(path, "AGENTS.md"), "CLAUDE.md", failed),
      ".agents/skills": ["symlink", "file", "other"].includes(io.kind(join(path, ".agents")))
        ? "conflict"
        : linkState(io, join(path, ".agents/skills"), "../.claude/skills", failed),
    },
    legacyManifestPresent: legacy,
    skills: skillStates(ctx.skills, managed, actual),
  };
}

function inspectReady(
  authority: WorkspaceVaultAuthority,
  input: WorkspaceInspectInput,
): WorkspaceStatus {
  requireAuthority(authority, input);
  const cfg = configured(authority);
  const raw = input.path?.trim() || cfg.path || authority.defaultPath;
  const path = checkWorkspacePath(raw, authority.vault, authority.policy);
  if (authority.publicationFor)
    authority = { ...authority, publication: authority.publicationFor(path) };
  // The publication of the chosen path: the default one is scoped to the default path only.
  const io = authority.publication;
  const manifest = manifestAt(authority, path);
  const owner = manifest.value?.vaultId;
  const conflict =
    manifest.legacy ||
    (owner && owner !== authority.vault) ||
    (!owner && truthyObject(manifest.value))
      ? "other_profile"
      : null;
  const exists = truthyObject(manifest.value) && manifest.valid && conflict === null;
  const ctx = targetContext(authority, path, cfg.routine);
  if (!ctx) return { availability: "unavailable", reason: "invocation_or_tools_unavailable" };
  const state = exists
    ? snapshot(authority, path, manifest.value ?? {}, ctx, manifest.legacy)
    : null;
  const outdated = state
    ? outdatedItems(
        state,
        renderSections(ctx),
        ctx,
        previous(manifest.value?.settings_deny),
        previous(manifest.value?.settings_routine),
      )
    : [];
  return {
    availability: "ready",
    path,
    defaultPath: authority.defaultPath,
    configured: cfg.path !== null,
    custom: cfg.path !== null && !samePath(cfg.path, authority.defaultPath),
    exists,
    folderExists: io.kind(path) === "directory",
    conflict,
    managedVersion: exists
      ? typeof manifest.value?.cashu_version === "string"
        ? manifest.value.cashu_version
        : typeof manifest.value?.finanse_version === "string"
          ? manifest.value.finanse_version
          : null
      : null,
    currentVersion: authority.version,
    updatedAt:
      exists && typeof manifest.value?.updated_at === "string" ? manifest.value.updated_at : null,
    upToDate: exists && outdated.length === 0,
    mcpCommandStale: state ? mcpCommandStale(state.mcp.value, ctx, ctx.cli.slice(1)) : false,
    outdated,
    skills: state?.skills ?? [],
    skillsSource: authority.skillsSourceAvailable,
    claudeCommand: command(path),
    routineCommand: command(path, "/market-research rutyna"),
    routinePermissions: cfg.routine,
  };
}

function applySteps(
  authority: WorkspaceVaultAuthority,
  input: WorkspaceApplyInput,
  path: string,
  ctx: WorkspaceRenderContext,
  manifest: Json,
  snap: WorkspaceSnapshot,
  invalidManifest: string | null,
): WorkspaceStep[] {
  const io = authority.publication;
  const steps: WorkspaceStep[] = [];
  const add = (kind: string, name: string, action: string, effect: () => void): void => {
    steps.push({ kind, name, action, effect });
  };
  const managedKind = (relative: string, allowed: readonly string[]): void => {
    if (!allowed.includes(io.kind(join(path, relative))))
      throw new WorkspacePathError("path_replaced");
  };
  if (io.kind(path) === "missing")
    add("folder", ".", "created", () => io.ensureDirectory(path, 0o700));
  for (const folder of FOLDERS) {
    managedKind(folder, ["missing", "directory"]);
    if (!snap.folders[folder])
      add("folder", folder, "created", () => io.ensureDirectory(join(path, folder)));
  }
  managedKind(".gitignore", ["missing", "file"]);
  if (io.kind(join(path, ".gitignore")) === "missing")
    add("gitignore", ".gitignore", "created", () =>
      io.writeText(join(path, ".gitignore"), "# raw exports never go into git\ninbox/\n"),
    );
  const merged = mergeClaudeMd(snap.claudeMd, renderSections(ctx), userPart);
  managedKind("CLAUDE.md", ["missing", "file"]);
  if (merged !== snap.claudeMd)
    add("claude_md", "CLAUDE.md", snap.claudeMd === null ? "created" : "updated", () =>
      io.writeText(join(path, "CLAUDE.md"), merged),
    );
  const stamp = authority.stamp();
  const syncJson = (
    relative: string,
    kind: string,
    old: WorkspaceSnapshot["mcp"],
    value: Json,
  ): void => {
    managedKind(relative, ["missing", "file"]);
    if (!old.valid)
      add(kind, relative, "backed_up", () =>
        io.backup(join(path, relative), join(path, ".claude", "cashu-backup", stamp, relative)),
      );
    if (!old.valid || !same(value, old.value))
      add(kind, relative, old.value === null ? "created" : "updated", () =>
        io.writeText(join(path, relative), jsonText(value)),
      );
  };
  syncJson(".mcp.json", "mcp", snap.mcp, mergeMcp(snap.mcp.value, ctx));
  const ownedRoutine = routineOwned(snap.settings.value, ctx, previous(manifest.settings_routine));
  syncJson(
    SETTINGS,
    "settings",
    snap.settings,
    mergeSettings(
      snap.settings.value,
      ctx,
      previous(manifest.settings_deny),
      previous(manifest.settings_routine),
    ),
  );
  const managed: Record<string, SkillRecord> = {};
  for (const item of planSkills(
    snap.skills,
    ctx.skills,
    skillRecords(manifest.skills),
    input.force === true,
  )) {
    if (item.record) managed[item.name] = item.record;
    const dest = join(path, SKILL_ROOT, item.name);
    managedKind(`${SKILL_ROOT}/${item.name}`, ["missing", "directory"]);
    if (item.action === "copy" || item.action === "update")
      add("skill", item.name, item.action === "copy" ? "created" : "updated", () =>
        io.copySkill(item.name, dest),
      );
    else if (item.action === "replace_with_backup") {
      add("skill", item.name, "backed_up", () =>
        io.backup(dest, join(path, ".claude", "cashu-backup", stamp, SKILL_ROOT, item.name)),
      );
      add("skill", item.name, "replaced", () => io.copySkill(item.name, dest));
    } else if (item.action === "remove")
      add("skill", item.name, "removed", () => io.removeSkill(dest));
    else if (item.action === "backup_disabled")
      add("skill", item.name, "backed_up", () =>
        io.backup(dest, join(path, ".claude", "cashu-backup", stamp, SKILL_ROOT, item.name)),
      );
    else if (item.action === "keep" || item.action === "release")
      add("skill", item.name, item.action === "keep" ? "kept" : "released", () => {});
  }
  const linksFailed: string[] = [];
  for (const [name, target] of [
    ["AGENTS.md", "CLAUDE.md"],
    [".agents/skills", "../.claude/skills"],
  ] as const) {
    const state = snap.links[name];
    if (state === "ok") continue;
    if (state === "conflict") add("link", name, "kept", () => {});
    else
      add("link", name, "created", () => {
        try {
          io.createLink(join(path, name), target);
        } catch {
          linksFailed.push(name);
          return "failed";
        }
      });
  }
  const newManifest: Json = {
    format: 1,
    profile: authority.slug,
    vaultId: authority.vault,
    cashu_version: authority.version,
    skills: managed,
    settings_deny: denyRules(ctx),
    settings_routine: ownedRoutine,
  };
  managedKind(MANIFEST, ["missing", "file"]);
  if (invalidManifest) {
    managedKind(invalidManifest, ["file"]);
    add("manifest", invalidManifest, "backed_up", () =>
      io.backup(
        join(path, invalidManifest),
        join(path, ".claude", "cashu-backup", stamp, invalidManifest),
      ),
    );
  }
  add(
    "manifest",
    MANIFEST,
    io.kind(join(path, MANIFEST)) === "missing" ? "created" : "updated",
    () => {
      if (linksFailed.length) newManifest.links_failed = linksFailed;
      const previousManifest = { ...manifest };
      delete previousManifest.updated_at;
      if (same(previousManifest, newManifest) && io.kind(join(path, MANIFEST)) !== "missing")
        return false;
      io.writeText(join(path, MANIFEST), jsonText({ ...newManifest, updated_at: authority.now() }));
    },
  );
  const wantedConfig = {
    format: 1,
    vaultId: authority.vault,
    path,
    routinePermissions: ctx.routinePermissions,
  };
  if (!["missing", "file"].includes(io.kind(configPath(authority))))
    throw new WorkspacePathError("path_replaced");
  const priorConfig = readJson(io, configPath(authority));
  if (!same(priorConfig.value, wantedConfig))
    add("config", "workspace.json", priorConfig.value ? "updated" : "created", () => {
      io.writeText(configPath(authority), jsonText(wantedConfig), 0o600);
      authority.recordConfiguredPath(path);
    });
  return steps;
}

/** No global installation or default provider: host supplies all vault and publication authority. */
export function createInjectedWorkspaceProvider(
  source: WorkspaceAuthoritySource,
): WorkspaceProvider {
  return {
    bind(vault: string): WorkspaceBinding | null {
      if (!VAULT.test(vault)) return null;
      const authority = source.bind(vault);
      if (!authority || authority.vault !== vault) return null;
      return {
        generation: authority.generation,
        isCurrent: () => authority.isCurrent(),
        async inspect(input) {
          try {
            return inspectReady(authority, input);
          } catch (error) {
            return {
              availability: "unavailable",
              reason: error instanceof WorkspacePathError ? error.code : "inspect_failed",
            };
          }
        },
        async apply(input): Promise<WorkspaceApplyResult> {
          if (ACTIVE_VAULTS.has(vault)) return { kind: "refused", code: "busy" };
          ACTIVE_VAULTS.add(vault);
          let pathLock: string | null = null;
          try {
            requireAuthority(authority, input);
            const cfg = configured(authority);
            const path = checkWorkspacePath(
              input.path?.trim() || cfg.path || authority.defaultPath,
              authority.vault,
              authority.policy,
            );
            const selected = authority.publicationFor
              ? { ...authority, publication: authority.publicationFor(path) }
              : authority;
            const candidate = pyCasefold(path.normalize("NFC"));
            if ([...ACTIVE_PATHS].some((held) => overlaps(candidate, held)))
              return { kind: "refused", code: "busy" };
            ACTIVE_PATHS.add(candidate);
            pathLock = candidate;
            const before = manifestAt(selected, path);
            if (before.legacy) return { kind: "refused", code: "workspace_taken" };
            if (before.value?.vaultId && before.value.vaultId !== selected.vault)
              return { kind: "refused", code: "workspace_taken" };
            if (!before.value?.vaultId && truthyObject(before.value))
              return { kind: "refused", code: "workspace_taken" };
            const ctx = targetContext(selected, path, input.routinePermissions ?? cfg.routine);
            if (!ctx) return { kind: "refused", code: "invocation_or_tools_unavailable" };
            const snap = snapshot(selected, path, before.value ?? {}, ctx, before.legacy);
            const invalidManifest = !before.valid ? MANIFEST : null;
            const steps = applySteps(
              selected,
              input,
              path,
              ctx,
              before.value ?? {},
              snap,
              invalidManifest,
            );
            return await runWorkspaceOperation({
              current: () => selected.isCurrent() && (input.isCurrent?.() ?? true),
              steps,
              inspect: async () => inspectReady(authority, input),
              movedFrom: cfg.path && !samePath(cfg.path, path) ? cfg.path : null,
            });
          } catch (error) {
            return {
              kind: "refused",
              code: error instanceof WorkspacePathError ? error.code : "write_failed",
            };
          } finally {
            ACTIVE_VAULTS.delete(vault);
            if (pathLock) ACTIVE_PATHS.delete(pathLock);
          }
        },
      };
    },
  };
}
