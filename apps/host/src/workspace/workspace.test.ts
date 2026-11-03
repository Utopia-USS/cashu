import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  mergeClaudeMd,
  mergeMcp,
  mergeSettings,
  outdatedItems,
  planSkills,
  readManagedSections,
  renderSections,
  rulePath,
  skillStates,
  userPart,
  type WorkspaceContentContext,
  wantedSkills,
} from "@cashu/domain/core";
import { afterEach, expect, test } from "vitest";
import { createInjectedWorkspaceProvider, type WorkspaceVaultAuthority } from "./adapter.js";
import {
  checkWorkspacePath,
  directoryIdentity,
  publishManagedText,
  WorkspacePathError,
} from "./files.js";
import { runWorkspaceOperation } from "./operations.js";
import { readSkillSource, treeHash } from "./skills.js";
import { createTempPublication } from "./testing/tempPublication.js";

const roots: string[] = [];
const REPO = resolve(import.meta.dirname, "../../../..");
const fresh = (): string => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-workspace-synthetic-")));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("skill ordering and modified vs outdated follow the source records", () => {
  const source = new Map(
    ["workspace-setup", "budget-setup", "import-builder", "investments-setup", "review"].map(
      (name) => [name, { name, version: "new", positive: "p", negative: "n" }] as const,
    ),
  );
  const wanted = wantedSkills(["budget", "investments"], source);
  expect(wanted.map((skill) => [skill.name, skill.module])).toEqual([
    ["workspace-setup", "core"],
    ["budget-setup", "budget"],
    ["import-builder", "budget"],
    ["investments-setup", "investments"],
    ["review", "investments"],
  ]);
  expect(
    skillStates(
      wanted,
      { "workspace-setup": { module: "core", version: "old" } },
      {
        "workspace-setup": "old",
        "budget-setup": "local",
        "import-builder": null,
      },
    )
      .slice(0, 3)
      .map((skill) => skill.state),
  ).toEqual(["outdated", "conflict", "missing"]);
  const states = skillStates(
    wanted,
    { "workspace-setup": { module: "core", version: "old" } },
    { "workspace-setup": "old", "budget-setup": "local", "import-builder": null },
  );
  expect(
    planSkills(states, wanted, { "workspace-setup": { module: "core", version: "old" } }, false)
      .slice(0, 3)
      .map((row) => row.action),
  ).toEqual(["update", "keep", "copy"]);
  expect(
    planSkills(states, wanted, { "workspace-setup": { module: "core", version: "old" } }, true)[1]
      ?.action,
  ).toBe("replace_with_backup");
});

test("failure after a real publication returns a partial receipt without replay", async () => {
  const root = fresh();
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const identity = directoryIdentity(workspace);
  let executions = 0;
  const result = await runWorkspaceOperation({
    current: () => true,
    movedFrom: null,
    inspect: async () => ({ availability: "unavailable", reason: "synthetic inspection" }),
    steps: [
      {
        kind: "claude_md",
        name: "CLAUDE.md",
        action: "created",
        effect: () => {
          executions++;
          publishManagedText(workspace, "CLAUDE.md", "first\n", identity);
        },
      },
      {
        kind: "mcp",
        name: ".mcp.json",
        action: "created",
        effect: () => {
          executions++;
          throw new Error("injected publication fault");
        },
      },
      {
        kind: "manifest",
        name: ".claude/cashu-workspace.json",
        action: "created",
        effect: () => {
          executions++;
        },
      },
    ],
  });
  expect(result).toMatchObject({
    kind: "partial",
    code: "write_failed",
    changes: [{ kind: "claude_md", name: "CLAUDE.md", action: "created" }],
  });
  expect(executions).toBe(2);
  expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("first\n");
});

test("status distinguishes absent files, changed managed blocks, invalid JSON and unsupported links", () => {
  const context = ctx(fresh());
  const sections = Object.fromEntries(
    ["layout", "profile", "privacy", "tools", "boundaries", "files", "skills", "research"].map(
      (name) => [name, `## ${name}`],
    ),
  ) as Parameters<typeof outdatedItems>[1];
  const snapshot: Parameters<typeof outdatedItems>[0] = {
    folders: { notes: true, research: true, scripts: true, connectors: true, inbox: true },
    claudeMd: "<!-- cashu:begin layout -->\nold\n<!-- cashu:end layout -->\n",
    mcp: { value: null, valid: true },
    settings: { value: null, valid: false },
    links: { "AGENTS.md": "unsupported", ".agents/skills": "conflict" },
    legacyManifestPresent: false,
    skills: [],
  };
  expect(readManagedSections(snapshot.claudeMd ?? "").layout).toBe("old");
  const outdated = outdatedItems(snapshot, sections, context, [], []);
  expect(outdated).toEqual(
    expect.arrayContaining([
      { kind: "claude_md", name: "layout", reason: "outdated" },
      { kind: "claude_md", name: "profile", reason: "missing" },
      { kind: "mcp", name: ".mcp.json", reason: "missing" },
      { kind: "settings", name: ".claude/settings.json", reason: "invalid" },
      { kind: "link", name: "AGENTS.md", reason: "unsupported" },
      { kind: "link", name: ".agents/skills", reason: "conflict" },
    ]),
  );
});

test("actual Python tree hash matches ordered nested synthetic skill", () => {
  const root = fresh();
  const skill = join(root, "skill");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "synthetic skill\n");
  writeFileSync(join(skill, "zz.md"), "root file ordered before directories\n");
  writeFileSync(join(skill, "references", "x.md"), "synthetic reference\n");
  writeFileSync(join(skill, ".DS_Store"), "ignored");
  const home = join(root, "home");
  for (const folder of [
    home,
    join(root, "data"),
    join(root, "workspaces"),
    join(root, "legacy"),
    join(root, "launchagents"),
  ])
    mkdirSync(folder);
  const py = spawnSync(
    join(REPO, ".venv", "bin", "python"),
    [
      "-c",
      "from pathlib import Path; from cashu.core.workspace.skills import tree_hash; import sys; print(tree_hash(Path(sys.argv[1])))",
      skill,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CASHU_DATA_DIR: join(root, "data"),
        CASHU_WORKSPACES_DIR: join(root, "workspaces"),
        CASHU_TESTING: "1",
        XDG_DATA_HOME: join(root, "legacy"),
        CASHU_LAUNCH_AGENTS_DIR: join(root, "launchagents"),
      },
    },
  );
  expect(py.status, py.stderr).toBe(0);
  expect(treeHash(skill)).toBe(py.stdout.trim());
});

test("shipped skill inventory is sourced from assets, with applicability and references", () => {
  const source = join(REPO, ".claude", "skills");
  for (const name of [
    "workspace-setup",
    "budget-setup",
    "assets-setup",
    "loans-setup",
    "investments-setup",
    "import-builder",
    "extension-builder",
    "market-research",
    "review",
  ]) {
    const skill = readSkillSource(source, name);
    expect(skill?.name).toBe(name);
    expect(skill?.version).toMatch(/^[0-9a-f]{12}$/);
    expect(skill?.positive).not.toBe("");
    expect(skill?.negative.startsWith("NOT ")).toBe(true);
  }
  expect(readSkillSource(source, "unshipped")).toBeNull();
});

const ctx = (root: string): WorkspaceContentContext => ({
  slug: "synthetic",
  version: "1",
  modules: [{ id: "investments", name: "Investments" }],
  tools: [{ name: "profile_overview", module: "core", write: false }],
  path: join(root, "workspace"),
  protected: [join(root, "data")],
  routinePermissions: true,
  invocation: {
    command: "/synthetic/cashu",
    args: ["mcp", "--profile", "synthetic"],
    server: "cashu-synthetic",
  },
});

test("MCP and permissions retain unrelated user entries and routine ownership", () => {
  const root = fresh();
  const context = ctx(root);
  expect(
    mergeMcp({ mcpServers: { "cashu-other": {}, user: { command: "u" } }, custom: 1 }, context),
  ).toEqual({
    mcpServers: {
      "cashu-synthetic": { command: "/synthetic/cashu", args: ["mcp", "--profile", "synthetic"] },
      user: { command: "u" },
    },
    custom: 1,
  });
  const merged = mergeSettings(
    {
      permissions: {
        allow: ["user-rule", "WebSearch", "mcp__cashu-other__x"],
        deny: ["user-deny"],
      },
      enabledMcpjsonServers: ["user", "cashu-other"],
    },
    context,
    [],
    [],
  );
  expect((merged.permissions as { allow: string[] }).allow).toEqual(
    expect.arrayContaining(["user-rule", "WebSearch", "mcp__cashu-synthetic__profile_overview"]),
  );
  expect(merged.enabledMcpjsonServers).toEqual(["cashu-synthetic", "user"]);
});

test("MCP and settings merges match the isolated Python source oracle", () => {
  const root = fresh();
  const home = join(root, "home");
  for (const folder of [
    home,
    join(root, "data"),
    join(root, "workspaces"),
    join(root, "legacy"),
    join(root, "launchagents"),
  ])
    mkdirSync(folder);
  const context = ctx(root);
  const oldMcp = {
    extra: { retained: true },
    mcpServers: { user: { command: "u" }, "finanse-old": {}, "cashu-other": {} },
  };
  const oldSettings = {
    permissions: {
      allow: ["WebSearch", "user-rule", "mcp__cashu-other__x"],
      deny: ["user-deny", `Read(/${context.path}/inbox/**)`],
    },
    enabledMcpjsonServers: ["user", "cashu-other"],
  };
  const code = `import json,sys\nfrom pathlib import Path\nfrom cashu.core.workspace import render\nraw=json.loads(sys.argv[1])\nc=render.Context(slug='synthetic',version='1',base_currency='PLN',privacy='strict',modules=(('investments','Investments'),),tools=(render.ToolInfo('profile_overview','core',False),),skills={},research_available=False,cli=('/synthetic/cashu',),path=Path(raw['path']),protected=(Path(raw['protected']),),routine_permissions=True)\nprint(json.dumps({'mcp':render.merge_mcp(raw['mcp'],c),'settings':render.merge_settings(raw['settings'],c,[],[])},sort_keys=True))`;
  const py = spawnSync(
    join(REPO, ".venv", "bin", "python"),
    [
      "-c",
      code,
      JSON.stringify({
        path: context.path,
        protected: context.protected[0],
        mcp: oldMcp,
        settings: oldSettings,
      }),
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CASHU_DATA_DIR: join(root, "data"),
        CASHU_WORKSPACES_DIR: join(root, "workspaces"),
        CASHU_TESTING: "1",
        XDG_DATA_HOME: join(root, "legacy"),
        CASHU_LAUNCH_AGENTS_DIR: join(root, "launchagents"),
      },
    },
  );
  expect(py.status, py.stderr).toBe(0);
  expect({
    mcp: mergeMcp(oldMcp, context),
    settings: mergeSettings(oldSettings, context, [], []),
  }).toEqual(JSON.parse(py.stdout));
});

test("permission rule paths match Python for POSIX, Windows drive and UNC forms", () => {
  const root = fresh(),
    home = join(root, "home");
  for (const folder of [
    home,
    join(root, "data"),
    join(root, "workspaces"),
    join(root, "legacy"),
    join(root, "launchagents"),
  ])
    mkdirSync(folder);
  const inputs = [
    "/Users/x",
    "C:\\Users\\x",
    "c:/Users/x",
    "\\\\Server\\Share\\Folder",
    "relative\\x",
  ];
  const py = spawnSync(
    join(REPO, ".venv", "bin", "python"),
    [
      "-c",
      "import json,sys; from pathlib import Path; from cashu.core.workspace.render import rule_path; print(json.dumps([rule_path(Path(s)) for s in json.loads(sys.argv[1])]))",
      JSON.stringify(inputs),
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CASHU_DATA_DIR: join(root, "data"),
        CASHU_WORKSPACES_DIR: join(root, "workspaces"),
        CASHU_TESTING: "1",
        XDG_DATA_HOME: join(root, "legacy"),
        CASHU_LAUNCH_AGENTS_DIR: join(root, "launchagents"),
      },
    },
  );
  expect(py.status, py.stderr).toBe(0);
  expect(inputs.map(rulePath)).toEqual(JSON.parse(py.stdout));
});

test("managed sections and new CLAUDE.md match isolated Python source in three contexts", () => {
  const root = fresh();
  const home = join(root, "home");
  for (const folder of [
    home,
    join(root, "data"),
    join(root, "workspaces"),
    join(root, "legacy"),
    join(root, "launchagents"),
  ])
    mkdirSync(folder);
  const cases = [
    { modules: [], privacy: "strict", routine: false, skills: [] },
    {
      modules: ["investments"],
      privacy: "amounts",
      routine: false,
      skills: ["workspace-setup", "market-research"],
    },
    {
      modules: ["investments"],
      privacy: "strict",
      routine: true,
      skills: ["workspace-setup", "market-research"],
    },
  ] as const;
  const existing =
    "# finanse agent workspace\n\n<!-- finanse:begin layout -->\nold managed text\n<!-- finanse:end layout -->\n\nUser note stays.\n";
  for (const item of cases) {
    const context = {
      ...ctx(root),
      modules: item.modules.map((id) => ({ id, name: "Investments" })),
      privacy: item.privacy,
      baseCurrency: "PLN",
      routinePermissions: item.routine,
      skills: item.skills.map((name) => ({
        name,
        module: name === "workspace-setup" ? "core" : "investments",
        version: "v",
        positive: "the task | case",
        negative: "NOT unrelated.",
      })),
      researchAvailable: true,
      cli: ["/synthetic/cashu"],
    };
    const code = `import json,sys\nfrom pathlib import Path\nfrom cashu.core.workspace import render,skills\nr=json.loads(sys.argv[1])\nss={n:skills.SkillSource(n,'core' if n=='workspace-setup' else 'investments',Path('/synthetic'), 'v',positive='the task | case',negative='NOT unrelated.') for n in r['skills']}\nc=render.Context(slug='synthetic',version='1',base_currency='PLN',privacy=r['privacy'],modules=tuple((m,'Investments') for m in r['modules']),tools=(render.ToolInfo('profile_overview','core',False),),skills=ss,research_available=True,cli=('/synthetic/cashu',),path=Path(r['path']),protected=(Path(r['protected']),),routine_permissions=r['routine'])\nprint(json.dumps({'sections':render.sections(c),'new':render.new_claude_md(c),'merged':render.merge_claude_md(r['existing'],c)},ensure_ascii=False))`;
    const py = spawnSync(
      join(REPO, ".venv", "bin", "python"),
      [
        "-c",
        code,
        JSON.stringify({ ...item, path: context.path, protected: context.protected[0], existing }),
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CASHU_DATA_DIR: join(root, "data"),
          CASHU_WORKSPACES_DIR: join(root, "workspaces"),
          CASHU_TESTING: "1",
          XDG_DATA_HOME: join(root, "legacy"),
          CASHU_LAUNCH_AGENTS_DIR: join(root, "launchagents"),
        },
      },
    );
    expect(py.status, py.stderr).toBe(0);
    const expected = JSON.parse(py.stdout);
    const sections = renderSections(context);
    expect(sections).toEqual(expected.sections);
    expect(mergeClaudeMd(null, sections, userPart)).toBe(expected.new);
    expect(mergeClaudeMd(existing, sections, userPart)).toBe(expected.merged);
  }
});

test("checked path refuses overlap, hidden folders, symlink escapes and foreign claims", () => {
  const root = fresh();
  const home = join(root, "home");
  const data = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(data);
  mkdirSync(outside);
  const policy = {
    home,
    protectedRoots: [data],
    checkout: join(root, "checkout"),
    claims: new Map([["other", join(root, "claimed")]]),
  };
  expect(checkWorkspacePath(join(root, "fresh", "nested", "workspace"), "vault", policy)).toBe(
    join(root, "fresh", "nested", "workspace"),
  );
  expect(() => checkWorkspacePath(join(root, "claimed", "child"), "vault", policy)).toThrowError(
    new WorkspacePathError("workspace_taken"),
  );
  expect(() => checkWorkspacePath(join(root, ".hidden", "ws"), "vault", policy)).toThrowError(
    new WorkspacePathError("path_hidden"),
  );
  expect(() =>
    checkWorkspacePath(join(root, "ws", "data-parent"), "vault", {
      ...policy,
      protectedRoots: [join(root, "ws", "data-parent", "data")],
    }),
  ).toThrowError(new WorkspacePathError("path_data_dir"));
  symlinkSync(outside, join(root, "alias"));
  expect(() => checkWorkspacePath(join(root, "alias", "ws"), "vault", policy)).toThrowError(
    new WorkspacePathError("path_symlink"),
  );
});

test("managed publication refuses a hardlink and changed folder identity", () => {
  const root = fresh();
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const identity = directoryIdentity(workspace);
  publishManagedText(workspace, "CLAUDE.md", "managed\n", identity);
  expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("managed\n");
  symlinkSync(join(workspace, "CLAUDE.md"), join(workspace, "link"));
  expect(() => publishManagedText(workspace, "link", "x", identity)).toThrowError(
    new WorkspacePathError("path_replaced"),
  );
  rmSync(workspace, { recursive: true });
  mkdirSync(workspace);
  expect(() => publishManagedText(workspace, "CLAUDE.md", "x", identity)).toThrowError(
    new WorkspacePathError("path_replaced"),
  );
});

function syntheticAuthority(root: string): WorkspaceVaultAuthority {
  const vault = "a".repeat(32);
  const home = join(root, "home"),
    dataRoot = join(root, "data"),
    workspaces = join(root, "workspaces"),
    source = join(root, "source");
  for (const folder of [home, dataRoot, workspaces, join(source, "workspace-setup")])
    mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(source, "workspace-setup", "SKILL.md"),
    "---\nname: workspace-setup\ndescription: |\n  Applicability - POSITIVE: synthetic layout.\n  Applicability - NEGATIVE: NOT other work.\n---\n\n# synthetic\n",
  );
  const skill = readSkillSource(source, "workspace-setup");
  if (!skill) throw new Error("missing synthetic skill");
  const defaultPath = join(workspaces, "synthetic");
  const claims = new Map<string, string>();
  return {
    vault,
    generation: "synthetic-1",
    slug: "synthetic",
    version: "1",
    dataRoot,
    defaultPath,
    modules: [],
    privacy: "strict",
    baseCurrency: "PLN",
    policy: { home, protectedRoots: [dataRoot], checkout: REPO, claims },
    shipped: new Map([[skill.name, skill]]),
    skillsSourceAvailable: true,
    invocation: {
      command: "/synthetic/cashu",
      args: ["mcp", "--profile", "synthetic"],
      server: "cashu-synthetic",
    },
    cli: ["/synthetic/cashu"],
    tools: [{ name: "profile_overview", module: "core", write: false }],
    protected: [dataRoot],
    legacySlugAmbiguous: false,
    publication: createTempPublication(defaultPath, dataRoot, source),
    recordConfiguredPath: (path) => {
      claims.set(vault, path);
    },
    isCurrent: () => true,
    now: () => "2026-11-03T00:00:00Z",
    stamp: () => "20261103-000000",
  };
}

const workspaceInput = {
  slug: "synthetic",
  modules: [],
  privacy: "strict",
  baseCurrency: "PLN",
} as const;
const inputFor = (authority: WorkspaceVaultAuthority) => ({
  ...workspaceInput,
  modules: authority.modules,
  privacy: authority.privacy,
  baseCurrency: authority.baseCurrency,
});

test("injected temp-FS provider creates, updates, preserves edits, backs up under force and relocates", async () => {
  const root = fresh();
  const base = syntheticAuthority(root);
  let current = base;
  const provider = createInjectedWorkspaceProvider({ bind: () => current });
  let binding = provider.bind(base.vault);
  expect(binding).not.toBeNull();
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    configured: false,
    exists: false,
  });
  const created = await binding?.apply(workspaceInput);
  expect(created?.kind).toBe("completed");
  expect(created?.status).toMatchObject({
    availability: "ready",
    configured: true,
    exists: true,
    upToDate: true,
  });
  expect(await binding?.apply(workspaceInput)).toMatchObject({ kind: "completed", changes: [] });
  const skillPath = join(base.defaultPath, ".claude", "skills", "workspace-setup", "SKILL.md");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}user edit\n`);
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    upToDate: false,
    skills: [{ state: "modified" }],
  });
  expect(await binding?.apply(workspaceInput)).toMatchObject({
    kind: "completed",
    changes: [{ kind: "skill", action: "kept" }],
  });
  expect(readFileSync(skillPath, "utf8")).toContain("user edit");
  expect((await binding?.apply({ ...workspaceInput, force: true }))?.kind).toBe("completed");
  expect(readFileSync(skillPath, "utf8")).not.toContain("user edit");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}second user edit\n`);
  expect((await binding?.apply({ ...workspaceInput, force: true }))?.kind).toBe("completed");
  const backupSkill = join(
    base.defaultPath,
    ".claude",
    "cashu-backup",
    "20261103-000000",
    ".claude",
    "skills",
    "workspace-setup",
  );
  expect(readFileSync(join(backupSkill, "SKILL.md"), "utf8")).toContain("user edit");
  expect(readFileSync(join(`${backupSkill}-2`, "SKILL.md"), "utf8")).toContain("second user edit");
  const moved = join(root, "workspaces", "moved");
  current = {
    ...base,
    publication: createTempPublication(moved, base.dataRoot, join(root, "source")),
  };
  binding = provider.bind(base.vault);
  const relocation = await binding?.apply({ ...workspaceInput, path: moved });
  expect(relocation).toMatchObject({ kind: "completed", movedFrom: base.defaultPath });
  expect(readFileSync(join(base.defaultPath, "CLAUDE.md"), "utf8")).toContain(
    "cashU agent workspace",
  );
  expect(readFileSync(join(moved, "CLAUDE.md"), "utf8")).toContain("cashU agent workspace");
});

test("injected temp-FS publication failure yields partial receipt and manual retry", async () => {
  const root = fresh();
  const base = syntheticAuthority(root);
  let fail = true;
  const io = base.publication;
  const authority = {
    ...base,
    publication: {
      ...io,
      writeText(path: string, text: string, mode?: number) {
        if (fail && path.endsWith(".mcp.json")) {
          fail = false;
          throw new Error("synthetic fault");
        }
        io.writeText(path, text, mode);
      },
    },
  };
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(base.vault);
  const first = await binding?.apply(workspaceInput);
  expect(first).toMatchObject({ kind: "partial", code: "write_failed" });
  if (first?.kind !== "partial") throw new Error("expected partial receipt");
  expect(first.changes.some((change) => change.kind === "claude_md")).toBe(true);
  expect(readFileSync(join(base.defaultPath, "CLAUDE.md"), "utf8")).toContain(
    "cashU agent workspace",
  );
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    configured: false,
    exists: false,
  });
  expect(await binding?.apply(workspaceInput)).toMatchObject({
    kind: "completed",
    status: { availability: "ready", exists: true },
  });
});

test("host operation currentness loss between real files stops later publications", async () => {
  const root = fresh(),
    base = syntheticAuthority(root),
    io = base.publication;
  let current = true;
  const authority = {
    ...base,
    publication: {
      ...io,
      writeText(path: string, content: string, mode?: number) {
        io.writeText(path, content, mode);
        if (path.endsWith("CLAUDE.md")) current = false;
      },
    },
  };
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(base.vault);
  const result = await binding?.apply({ ...workspaceInput, isCurrent: () => current });
  expect(result).toMatchObject({ kind: "partial", code: "stale_capability" });
  if (result?.kind !== "partial") throw new Error("expected partial receipt");
  expect(result.changes.some((change) => change.kind === "claude_md")).toBe(true);
  expect(readFileSync(join(base.defaultPath, "CLAUDE.md"), "utf8")).toContain(
    "cashU agent workspace",
  );
  expect(io.kind(join(base.defaultPath, ".mcp.json"))).toBe("missing");
  expect(io.kind(join(base.dataRoot, "workspace", "v1", `${base.vault}.json`))).toBe("missing");
});

test("three contenders cannot erase a held path lock or claim an overlapping target", async () => {
  const root = fresh();
  const base = syntheticAuthority(root);
  const claims = base.policy.claims as Map<string, string>;
  const io = base.publication;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstAuthority: WorkspaceVaultAuthority = {
    ...base,
    publication: {
      ...io,
      writeText(path, content, mode) {
        if (path.endsWith("CLAUDE.md")) {
          entered?.();
          return gate.then(() => {
            io.writeText(path, content, mode);
          });
        }
        io.writeText(path, content, mode);
      },
    },
  };
  const otherVault = "b".repeat(32);
  const secondAuthority: WorkspaceVaultAuthority = {
    ...base,
    vault: otherVault,
    recordConfiguredPath: (path) => {
      claims.set(otherVault, path);
    },
  };
  const provider = createInjectedWorkspaceProvider({
    bind: (vault) =>
      vault === base.vault ? firstAuthority : vault === otherVault ? secondAuthority : null,
  });
  const first = provider.bind(base.vault)?.apply(workspaceInput);
  // The first publication is held before it acknowledges its managed CLAUDE.md step.
  await paused;
  expect(await provider.bind(otherVault)?.apply(workspaceInput)).toMatchObject({
    kind: "refused",
    code: "busy",
  });
  expect(
    await provider
      .bind(otherVault)
      ?.apply({ ...workspaceInput, path: join(base.defaultPath, "child") }),
  ).toMatchObject({ kind: "refused", code: "busy" });
  expect(await provider.bind(otherVault)?.apply(workspaceInput)).toMatchObject({
    kind: "refused",
    code: "busy",
  });
  release?.();
  expect(await first).toMatchObject({ kind: "completed" });
  expect(claims.get(base.vault)).toBe(base.defaultPath);
  expect(await provider.bind(otherVault)?.apply(workspaceInput)).toMatchObject({
    kind: "refused",
    code: "workspace_taken",
  });
});

test("empty manifest and user-owned .agents file are distinct from a foreign workspace", async () => {
  const root = fresh(),
    authority = syntheticAuthority(root);
  mkdirSync(join(authority.defaultPath, ".claude"), { recursive: true });
  writeFileSync(join(authority.defaultPath, ".claude", "cashu-workspace.json"), "{}\n");
  writeFileSync(join(authority.defaultPath, ".agents"), "user-owned\n");
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(authority.vault);
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    exists: false,
    conflict: null,
  });
  const result = await binding?.apply(workspaceInput);
  expect(result).toMatchObject({
    kind: "completed",
    changes: expect.arrayContaining([{ kind: "link", name: ".agents/skills", action: "kept" }]),
  });
  expect(readFileSync(join(authority.defaultPath, ".agents"), "utf8")).toBe("user-owned\n");
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    exists: true,
    upToDate: false,
  });
});

test("an equivalent absolute AGENTS link stays current", async () => {
  const root = fresh(),
    authority = syntheticAuthority(root);
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(authority.vault);
  expect((await binding?.apply(workspaceInput))?.kind).toBe("completed");
  rmSync(join(authority.defaultPath, "AGENTS.md"));
  symlinkSync(join(authority.defaultPath, "CLAUDE.md"), join(authority.defaultPath, "AGENTS.md"));
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    upToDate: true,
  });
});

test("invalid managed JSON is backed up and a valid replacement is published", async () => {
  const root = fresh(),
    authority = syntheticAuthority(root);
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(authority.vault);
  expect((await binding?.apply(workspaceInput))?.kind).toBe("completed");
  writeFileSync(join(authority.defaultPath, ".mcp.json"), "{ invalid synthetic json");
  writeFileSync(
    join(authority.defaultPath, ".claude", "settings.json"),
    "[ invalid synthetic json",
  );
  writeFileSync(
    join(authority.defaultPath, ".claude", "cashu-workspace.json"),
    "{ invalid synthetic manifest",
  );
  const result = await binding?.apply(workspaceInput);
  expect(result?.kind).toBe("completed");
  const backup = join(authority.defaultPath, ".claude", "cashu-backup", "20261103-000000");
  expect(readFileSync(join(backup, ".mcp.json"), "utf8")).toContain("invalid synthetic json");
  expect(readFileSync(join(backup, ".claude", "settings.json"), "utf8")).toContain(
    "invalid synthetic json",
  );
  expect(readFileSync(join(backup, ".claude", "cashu-workspace.json"), "utf8")).toContain(
    "invalid synthetic manifest",
  );
  expect(await binding?.inspect(workspaceInput)).toMatchObject({
    availability: "ready",
    exists: true,
    upToDate: true,
  });
});

test("disabled managed skills remove unchanged copies and release edited copies", async () => {
  const root = fresh(),
    base = syntheticAuthority(root);
  const source = join(root, "source"),
    budget = join(source, "budget-setup");
  mkdirSync(budget);
  writeFileSync(
    join(budget, "SKILL.md"),
    "---\nname: budget-setup\ndescription: |\n  Applicability - POSITIVE: synthetic budget.\n  Applicability - NEGATIVE: NOT other work.\n---\n",
  );
  const skill = readSkillSource(source, "budget-setup");
  if (!skill) throw new Error("missing synthetic budget skill");
  const shipped = new Map([...base.shipped, [skill.name, skill]]);
  let authority = { ...base, modules: [{ id: "budget", name: "Budget" }], shipped };
  const provider = createInjectedWorkspaceProvider({ bind: () => authority });
  expect((await provider.bind(base.vault)?.apply(inputFor(authority)))?.kind).toBe("completed");
  const target = join(base.defaultPath, ".claude", "skills", "budget-setup", "SKILL.md");
  authority = { ...authority, modules: [] };
  expect((await provider.bind(base.vault)?.apply(inputFor(authority)))?.kind).toBe("completed");
  expect(authority.publication.kind(target)).toBe("missing");
  authority = { ...authority, modules: [{ id: "budget", name: "Budget" }] };
  expect((await provider.bind(base.vault)?.apply(inputFor(authority)))?.kind).toBe("completed");
  writeFileSync(target, `${readFileSync(target, "utf8")}user edit\n`);
  authority = { ...authority, modules: [] };
  expect(await provider.bind(base.vault)?.apply(inputFor(authority))).toMatchObject({
    kind: "completed",
    changes: expect.arrayContaining([{ kind: "skill", name: "budget-setup", action: "released" }]),
  });
  expect(readFileSync(target, "utf8")).toContain("user edit");
  const manifest = JSON.parse(
    readFileSync(join(base.defaultPath, ".claude", "cashu-workspace.json"), "utf8"),
  );
  expect(manifest.skills["budget-setup"]).toBeUndefined();
});

test("routine opt-in owns only added rules and survives investment disable", async () => {
  const root = fresh(),
    base = syntheticAuthority(root);
  mkdirSync(join(base.defaultPath, ".claude"), { recursive: true });
  writeFileSync(
    join(base.defaultPath, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["WebSearch", "user-rule"] } }),
  );
  let authority = { ...base, modules: [{ id: "investments", name: "Investments" }] };
  const provider = createInjectedWorkspaceProvider({ bind: () => authority });
  expect(
    (await provider.bind(base.vault)?.apply({ ...inputFor(authority), routinePermissions: true }))
      ?.kind,
  ).toBe("completed");
  const settingsPath = join(base.defaultPath, ".claude", "settings.json");
  const readAllow = (): string[] =>
    JSON.parse(readFileSync(settingsPath, "utf8")).permissions.allow;
  expect(readAllow()).toContain("WebSearch");
  expect(readAllow()).toContain("WebFetch");
  expect(readAllow().some((rule) => rule.includes("/research/**"))).toBe(true);
  expect(
    (await provider.bind(base.vault)?.apply({ ...inputFor(authority), routinePermissions: false }))
      ?.kind,
  ).toBe("completed");
  expect(readAllow()).toContain("WebSearch");
  expect(readAllow()).not.toContain("WebFetch");
  expect(readAllow().some((rule) => rule.includes("/research/**"))).toBe(false);
  expect(
    (await provider.bind(base.vault)?.apply({ ...inputFor(authority), routinePermissions: true }))
      ?.kind,
  ).toBe("completed");
  authority = { ...authority, modules: [] };
  expect((await provider.bind(base.vault)?.apply(inputFor(authority)))?.kind).toBe("completed");
  expect(await provider.bind(base.vault)?.inspect(inputFor(authority))).toMatchObject({
    availability: "ready",
    routinePermissions: true,
  });
  expect(readAllow()).toContain("WebSearch");
  expect(readAllow()).not.toContain("WebFetch");
});

test("committed privacy and base-currency facts refresh managed text without touching user prose", async () => {
  const root = fresh(),
    base = syntheticAuthority(root);
  let authority = base;
  const provider = createInjectedWorkspaceProvider({ bind: () => authority });
  expect((await provider.bind(base.vault)?.apply(workspaceInput))?.kind).toBe("completed");
  const claudePath = join(base.defaultPath, "CLAUDE.md");
  writeFileSync(claudePath, `${readFileSync(claudePath, "utf8")}\nUser note stays.\n`);
  authority = { ...base, privacy: "amounts", baseCurrency: "EUR" };
  expect((await provider.bind(base.vault)?.apply(inputFor(authority)))?.kind).toBe("completed");
  const text = readFileSync(claudePath, "utf8");
  expect(text).toContain("**amounts**");
  expect(text).toContain("Base currency: EUR.");
  expect(text).toContain("User note stays.");
});

test("stale module, privacy or currency input refuses before publication", async () => {
  const root = fresh(),
    authority = syntheticAuthority(root);
  const binding = createInjectedWorkspaceProvider({ bind: () => authority }).bind(authority.vault);
  for (const stale of [
    { ...workspaceInput, modules: [{ id: "budget", name: "Budget" }] },
    { ...workspaceInput, privacy: "amounts" as const },
    { ...workspaceInput, baseCurrency: "EUR" },
  ]) {
    expect(await binding?.inspect(stale)).toMatchObject({
      availability: "unavailable",
      reason: "stale_context",
    });
    expect(await binding?.apply(stale)).toMatchObject({ kind: "refused", code: "stale_context" });
    expect(authority.publication.kind(authority.defaultPath)).toBe("missing");
  }
});

test("legacy slug manifest upgrades only when native ownership is unambiguous", async () => {
  const root = fresh(),
    base = syntheticAuthority(root);
  const provider = createInjectedWorkspaceProvider({ bind: () => base });
  expect((await provider.bind(base.vault)?.apply(workspaceInput))?.kind).toBe("completed");
  const current = join(base.defaultPath, ".claude", "cashu-workspace.json");
  const legacy = join(base.defaultPath, ".claude", "finanse-workspace.json");
  const manifest = JSON.parse(readFileSync(current, "utf8"));
  delete manifest.vaultId;
  writeFileSync(legacy, JSON.stringify(manifest));
  rmSync(current);
  const ambiguous = { ...base, legacySlugAmbiguous: true };
  const ambiguousProvider = createInjectedWorkspaceProvider({ bind: () => ambiguous });
  expect(await ambiguousProvider.bind(base.vault)?.apply(workspaceInput)).toMatchObject({
    kind: "refused",
    code: "workspace_taken",
  });
  expect(readFileSync(legacy, "utf8")).toContain("synthetic");
  const upgraded = await provider.bind(base.vault)?.apply(workspaceInput);
  expect(upgraded?.kind).toBe("completed");
  expect(JSON.parse(readFileSync(current, "utf8")).vaultId).toBe(base.vault);
  expect(base.publication.kind(legacy)).toBe("missing");
});
