/** Pure workspace policy. Files, hashes, clocks and invocation authority are supplied by the host. */
export const MODULE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  budget: ["budget-setup", "import-builder"],
  assets: ["assets-setup"],
  loans: ["loans-setup"],
  investments: [
    "investments-setup",
    "import-builder",
    "extension-builder",
    "market-research",
    "review",
  ],
};

export interface SkillSource {
  readonly name: string;
  readonly version: string;
  readonly positive: string;
  readonly negative: string;
}

export interface WantedSkill extends SkillSource {
  readonly module: string;
}

export interface SkillRecord {
  readonly module: string;
  readonly version: string;
}

export type SkillStateName = "missing" | "ok" | "outdated" | "modified" | "conflict" | "extra";
export interface SkillState {
  readonly name: string;
  readonly module: string | null;
  readonly version: string;
  readonly state: SkillStateName;
}

export function wantedSkills(
  modules: readonly string[],
  shipped: ReadonlyMap<string, SkillSource>,
): WantedSkill[] {
  const out: WantedSkill[] = [];
  const add = (name: string, module: string) => {
    const source = shipped.get(name);
    if (source && !out.some((item) => item.name === name)) out.push({ ...source, module });
  };
  add("workspace-setup", "core");
  for (const module of modules) for (const name of MODULE_SKILLS[module] ?? []) add(name, module);
  return out;
}

export function skillStates(
  wanted: readonly WantedSkill[],
  managed: Readonly<Record<string, SkillRecord>>,
  actual: Readonly<Record<string, string | null>>,
): SkillState[] {
  const out: SkillState[] = [];
  for (const source of wanted) {
    const current = actual[source.name];
    const recorded = managed[source.name];
    const state: SkillStateName =
      current == null
        ? "missing"
        : current === source.version
          ? "ok"
          : !recorded
            ? "conflict"
            : current !== recorded.version
              ? "modified"
              : "outdated";
    out.push({ name: source.name, module: source.module, version: source.version, state });
  }
  for (const [name, record] of Object.entries(managed)) {
    if (wanted.some((source) => source.name === name) || actual[name] == null) continue;
    out.push({
      name,
      module: record.module,
      version: record.version,
      state: actual[name] === record.version ? "extra" : "modified",
    });
  }
  return out;
}

export type SkillAction =
  | "copy"
  | "update"
  | "keep"
  | "replace_with_backup"
  | "remove"
  | "release"
  | "backup_disabled"
  | "none";
export interface SkillPlan {
  readonly name: string;
  readonly state: SkillStateName;
  readonly action: SkillAction;
  /** Record to persist after the action, if cashU still owns this skill. */
  readonly record: SkillRecord | null;
}

/** Plans source-compatible ownership transitions without inspecting files. */
export function planSkills(
  states: readonly SkillState[],
  wanted: readonly WantedSkill[],
  previous: Readonly<Record<string, SkillRecord>>,
  force: boolean,
): SkillPlan[] {
  const desired = new Map(wanted.map((skill) => [skill.name, skill]));
  return states.map((skill) => {
    const source = desired.get(skill.name);
    if (!source)
      return {
        name: skill.name,
        state: skill.state,
        action: skill.state === "extra" ? "remove" : force ? "backup_disabled" : "release",
        record: null,
      };
    const record = { module: source.module, version: source.version };
    if (skill.state === "ok")
      return { name: skill.name, state: skill.state, action: "none", record };
    if (skill.state === "missing")
      return { name: skill.name, state: skill.state, action: "copy", record };
    if (skill.state === "outdated")
      return { name: skill.name, state: skill.state, action: "update", record };
    if (force)
      return { name: skill.name, state: skill.state, action: "replace_with_backup", record };
    return {
      name: skill.name,
      state: skill.state,
      action: "keep",
      record: skill.state === "modified" ? (previous[skill.name] ?? null) : null,
    };
  });
}

export interface WorkspaceTool {
  readonly name: string;
  readonly module: string;
  readonly write: boolean;
}
export interface WorkspaceContentContext {
  readonly slug: string;
  readonly version: string;
  readonly modules: readonly { readonly id: string; readonly name: string }[];
  readonly tools: readonly WorkspaceTool[];
  readonly path: string;
  readonly protected: readonly string[];
  readonly routinePermissions: boolean;
  /** Actual executable and arguments, bound to the selected vault. Never guessed from a slug. */
  readonly invocation: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly server: string;
  };
}

type JsonMap = Record<string, unknown>;
const object = (value: unknown): JsonMap =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
const cashuServer = (name: string): boolean =>
  name === "cashu" ||
  name.startsWith("cashu-") ||
  name === "finanse" ||
  name.startsWith("finanse-");
const managedRule = (rule: string): boolean =>
  rule.startsWith("mcp__cashu-") || rule.startsWith("mcp__finanse-");
/** Python render.rule_path, including drive paths supplied while running on POSIX. */
export function rulePath(path: string): string {
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(path);
  if (unc)
    return `//\\\\${unc[1]?.toLowerCase()}\\${unc[2]?.toLowerCase()}/${(unc[3] ?? "")
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/")}`;
  const drive = /^([A-Za-z]):(.*)$/.exec(path);
  if (drive)
    return `//${drive[1]?.toLowerCase()}/${(drive[2] ?? "")
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/")}`;
  return `/${path}`;
}

export function mergeMcp(existing: unknown, ctx: WorkspaceContentContext): JsonMap {
  const data = { ...object(existing) };
  const kept = Object.fromEntries(
    Object.entries(object(data.mcpServers)).filter(([name]) => !cashuServer(name)),
  );
  data.mcpServers = {
    [ctx.invocation.server]: {
      command: ctx.invocation.command,
      args: [...ctx.invocation.args],
      ...(ctx.invocation.env && Object.keys(ctx.invocation.env).length
        ? { env: { ...ctx.invocation.env } }
        : {}),
    },
    ...kept,
  };
  return data;
}

export function denyRules(ctx: WorkspaceContentContext): string[] {
  return ctx.protected.flatMap((path) =>
    ["Read", "Edit"].map((tool) => `${tool}(${rulePath(path)}/**)`),
  );
}

export function routineRules(ctx: WorkspaceContentContext): string[] {
  if (!ctx.routinePermissions || !ctx.modules.some((m) => m.id === "investments")) return [];
  return [
    "WebSearch",
    "WebFetch",
    `Edit(${rulePath(`${ctx.path}/research`)}/**)`,
    `Edit(${rulePath(`${ctx.path}/notes`)}/**)`,
  ];
}

export function routineOwned(
  existing: unknown,
  ctx: WorkspaceContentContext,
  previous: readonly string[],
): string[] {
  const user = strings(object(object(existing).permissions).allow).filter(
    (r) => !managedRule(r) && !previous.includes(r),
  );
  return routineRules(ctx).filter((r) => !user.includes(r));
}

export function mergeSettings(
  existing: unknown,
  ctx: WorkspaceContentContext,
  previousDeny: readonly string[],
  previousRoutine: readonly string[],
): JsonMap {
  const data = { ...object(existing) };
  const perms = { ...object(data.permissions) };
  const ours = [
    ...ctx.tools.map((tool) => `mcp__${ctx.invocation.server}__${tool.name}`),
    ...routineRules(ctx),
  ];
  perms.allow = [
    ...ours,
    ...strings(perms.allow).filter(
      (r) => !managedRule(r) && !previousRoutine.includes(r) && !ours.includes(r),
    ),
  ];
  const deny = denyRules(ctx);
  const obsolete = new Set([
    ...previousDeny,
    `Read(${rulePath(`${ctx.path}/inbox`)}/**)`,
    `Edit(${rulePath(`${ctx.path}/inbox`)}/**)`,
  ]);
  perms.deny = [
    ...deny,
    ...strings(perms.deny).filter((r) => !obsolete.has(r) && !deny.includes(r)),
  ];
  data.permissions = perms;
  data.enabledMcpjsonServers = [
    ctx.invocation.server,
    ...strings(data.enabledMcpjsonServers).filter((s) => !cashuServer(s)),
  ];
  return data;
}

export const MANAGED_SECTIONS = [
  "layout",
  "profile",
  "privacy",
  "tools",
  "boundaries",
  "files",
  "skills",
  "research",
] as const;
export type ManagedSection = (typeof MANAGED_SECTIONS)[number];
export type ManagedSections = Readonly<Record<ManagedSection, string>>;

export interface WorkspaceSnapshot {
  readonly folders: Readonly<Record<string, boolean>>;
  readonly claudeMd: string | null;
  readonly mcp: { readonly value: unknown | null; readonly valid: boolean };
  readonly settings: { readonly value: unknown | null; readonly valid: boolean };
  readonly links: Readonly<Record<string, "ok" | "missing" | "unsupported" | "conflict">>;
  readonly legacyManifestPresent: boolean;
  readonly skills: readonly SkillState[];
}

export interface OutdatedItem {
  readonly kind: "folder" | "claude_md" | "mcp" | "settings" | "skill" | "link" | "manifest";
  readonly name: string;
  readonly reason: string;
}

export function readManagedSections(text: string): Partial<Record<ManagedSection, string>> {
  const out: Partial<Record<ManagedSection, string>> = {};
  for (const name of MANAGED_SECTIONS) {
    const begin = `<!-- cashu:begin ${name} -->`;
    const end = `<!-- cashu:end ${name} -->`;
    const start = text.indexOf(begin);
    const finish = start < 0 ? -1 : text.indexOf(end, start + begin.length);
    if (finish >= 0)
      out[name] = text
        .slice(start + begin.length, finish)
        .replace(/^\n?/, "")
        .replace(/\n?$/, "");
  }
  return out;
}

export function outdatedItems(
  snapshot: WorkspaceSnapshot,
  wantedSections: ManagedSections,
  ctx: WorkspaceContentContext,
  previousDeny: readonly string[],
  previousRoutine: readonly string[],
): OutdatedItem[] {
  const out: OutdatedItem[] = [];
  const add = (kind: OutdatedItem["kind"], name: string, reason: string) =>
    out.push({ kind, name, reason });
  for (const name of ["notes", "research", "scripts", "connectors", "inbox"])
    if (!snapshot.folders[name]) add("folder", name, "missing");
  if (snapshot.legacyManifestPresent) add("manifest", ".claude/finanse-workspace.json", "outdated");
  if (snapshot.claudeMd === null) add("claude_md", "CLAUDE.md", "missing");
  else {
    const actual = readManagedSections(snapshot.claudeMd);
    for (const name of MANAGED_SECTIONS) {
      if (actual[name] === undefined) add("claude_md", name, "missing");
      else if (actual[name] !== wantedSections[name]) add("claude_md", name, "outdated");
    }
  }
  for (const [kind, file, input, merge] of [
    ["mcp", ".mcp.json", snapshot.mcp, (value: unknown) => mergeMcp(value, ctx)],
    [
      "settings",
      ".claude/settings.json",
      snapshot.settings,
      (value: unknown) => mergeSettings(value, ctx, previousDeny, previousRoutine),
    ],
  ] as const) {
    if (!input.valid) add(kind, file, "invalid");
    else if (input.value === null) add(kind, file, "missing");
    else if (!sameJson(merge(input.value), input.value)) add(kind, file, "outdated");
  }
  for (const skill of snapshot.skills)
    if (skill.state !== "ok") add("skill", skill.name, skill.state);
  for (const name of ["AGENTS.md", ".agents/skills"] as const) {
    const state = snapshot.links[name] ?? "missing";
    if (state !== "ok") add("link", name, state);
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameJson(x, b[i]))
    );
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = object(a),
      right = object(b);
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
    );
  }
  return false;
}

export function mcpCommandStale(
  existing: unknown,
  ctx: WorkspaceContentContext,
  cliPrefix: readonly string[],
): boolean {
  const entry = object(object(object(existing).mcpServers)[ctx.invocation.server]);
  if (Object.keys(entry).length === 0) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return (
    entry.command !== ctx.invocation.command || cliPrefix.some((arg, index) => args[index] !== arg)
  );
}

/** Source-compatible replacement preserves every byte outside recognized managed markers. */
export function mergeClaudeMd(
  existing: string | null,
  sections: ManagedSections,
  userPart: string,
): string {
  if (existing === null)
    return `# cashU agent workspace\n\n${MANAGED_SECTIONS.map((name) => block(name, sections[name])).join("\n\n")}\n\n${userPart}`;
  let text = existing.replace(/<!-- finanse:(begin|end) ([a-z_]+) -->/g, "<!-- cashu:$1 $2 -->");
  if (text.startsWith("# finanse agent workspace\n"))
    text = `# cashU agent workspace${text.slice("# finanse agent workspace".length)}`;
  let lastEnd = -1;
  for (const name of MANAGED_SECTIONS) {
    const replacement = block(name, sections[name]);
    const begin = `<!-- cashu:begin ${name} -->`;
    const end = `<!-- cashu:end ${name} -->`;
    const start = text.indexOf(begin);
    const finish = start < 0 ? -1 : text.indexOf(end, start + begin.length);
    if (finish >= 0) {
      const after = finish + end.length;
      text = text.slice(0, start) + replacement + text.slice(after);
      lastEnd = start + replacement.length;
    } else if (lastEnd >= 0) {
      const insert = `\n\n${replacement}`;
      text = text.slice(0, lastEnd) + insert + text.slice(lastEnd);
      lastEnd += insert.length;
    } else {
      const first = text.indexOf("\n");
      const title = text.startsWith("# ") ? text.slice(0, first < 0 ? text.length : first) : "";
      const rest = title ? text.slice(title.length).replace(/^\n+/, "") : text;
      text = `${title ? `${title}\n\n` : ""}${replacement}\n\n${rest}`;
      lastEnd = (title ? title.length + 2 : 0) + replacement.length;
    }
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function block(name: ManagedSection, content: string): string {
  return `<!-- cashu:begin ${name} -->\n${content}\n<!-- cashu:end ${name} -->`;
}
