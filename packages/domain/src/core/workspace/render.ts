import { powershellQuote, shellCommandLine, shlexQuote } from "../setup.js";
import type { ManagedSections, WantedSkill, WorkspaceContentContext } from "./plan.js";
import { SOURCE_ROUTES, SOURCE_TEMPLATES } from "./templates.js";

export interface WorkspaceRenderContext extends WorkspaceContentContext {
  readonly privacy: "strict" | "amounts";
  readonly baseCurrency: string;
  readonly skills: readonly WantedSkill[];
  readonly researchAvailable: boolean;
  /** Genuine CLI program argv for this exact bound vault; not inferred from a display slug. */
  readonly cli: readonly string[];
  /**
   * `process.platform` of the host that writes the workspace (absent: an sh-compatible shell). It
   * picks the shell of the command lines in CLAUDE.md (`shellCommandLine`): they are for the user's
   * own terminal, PowerShell on Windows, as on the app's setup card.
   */
  readonly platform?: string;
}

/**
 * The command that opens Claude Code in the workspace `path` (with `prompt`, a one-shot run), for the
 * user's terminal on `platform`. PowerShell (Windows): `Set-Location -LiteralPath` takes the path
 * as it is (no wildcards) and `-ErrorAction Stop` ends the line when the folder is missing, since
 * Windows PowerShell 5.1 has no `&&`.
 */
export function claudeCommand(path: string, prompt?: string, platform?: string): string {
  if (platform === "win32")
    return `Set-Location -LiteralPath ${powershellQuote(path)} -ErrorAction Stop; claude${prompt ? ` -p ${powershellQuote(prompt)}` : ""}`;
  return `cd ${shlexQuote(path)} && claude${prompt ? ` -p ${shlexQuote(prompt)}` : ""}`;
}
const replace = (text: string, from: string, to: string): string => text.replaceAll(from, to);
const cell = (text: string): string =>
  text.trim().split(/\s+/).join(" ").replaceAll("|", "/") || "-";

export function renderSections(ctx: WorkspaceRenderContext): ManagedSections {
  if (!ctx.cli.length || ctx.invocation.command !== ctx.cli[0])
    throw new Error("invocation_unavailable");
  const server = ctx.invocation.server;
  const profileModules = ctx.modules.length
    ? ctx.modules.map((m) => `${m.name} (\`${m.id}\`)`).join(", ")
    : "none (net worth only)";
  const cliLine = shellCommandLine([...ctx.cli, "--profile", ctx.slug], ctx.platform);
  const updateLine = shellCommandLine(
    [...ctx.cli, "workspace", "update", "--profile", ctx.slug],
    ctx.platform,
  );
  let profile = replace(SOURCE_TEMPLATES.profile, "cashu-tokenslug", server);
  profile = replace(profile, "/TOKEN_CLI --profile tokenslug", cliLine);
  profile = replace(profile, "/TOKEN_CLI workspace update --profile tokenslug", updateLine);
  profile = replace(profile, "tokenslug", ctx.slug);
  profile = replace(profile, "none (net worth only)", profileModules);
  profile = replace(profile, "TOKEN_CURRENCY", ctx.baseCurrency);
  profile = replace(profile, "TOKEN_VERSION", ctx.version);

  const byModule = new Map<string, string[]>();
  for (const tool of ctx.tools)
    byModule.set(tool.module, [
      ...(byModule.get(tool.module) ?? []),
      `\`${tool.name}\`${tool.write ? " (write)" : ""}`,
    ]);
  const toolLines = ["core", ...ctx.modules.map((m) => m.id)]
    .filter((id) => byModule.has(id))
    .map((id) => `- ${id}: ${byModule.get(id)?.join(", ")}`);
  const tools = replace(
    replace(SOURCE_TEMPLATES.tools, "cashu-tokenslug", server),
    "- (none)",
    toolLines.join("\n") || "- (none)",
  );

  const places = ctx.protected.map((path) => `  - \`${path}\``).join("\n");
  const boundaries = replace(SOURCE_TEMPLATES.boundaries, "  - `/TOKEN_PROTECTED`", places);

  const inventory = ctx.skills.length
    ? `| Skill | Module | Applies to | Does not apply to |\n|---|---|---|---|\n${ctx.skills.map((skill) => `| \`/${skill.name}\` | ${skill.module} | ${cell(skill.positive)} | ${cell(skill.negative)} |`).join("\n")}`
    : "(none for the enabled modules)";
  const routes = SOURCE_ROUTES.filter(([name]) => ctx.skills.some((s) => s.name === name));
  const when = routes.length
    ? `\n\n## When to Invoke\n\n| Situation | Skill |\n|---|---|\n${routes.map(([name, situation]) => `| ${situation} | \`/${name}\` |`).join("\n")}\n| Any question about the profile's data | the MCP tools above, never files |`
    : "";
  const skills = replace(
    SOURCE_TEMPLATES.skills,
    "(none for the enabled modules)",
    `${inventory}${when}`,
  );

  const researchTemplate = !ctx.modules.some((m) => m.id === "investments")
    ? SOURCE_TEMPLATES.researchOff
    : !ctx.researchAvailable
      ? SOURCE_TEMPLATES.researchMissing
      : ctx.routinePermissions
        ? SOURCE_TEMPLATES.researchReadyOn
        : SOURCE_TEMPLATES.researchReadyOff;
  const research = replace(
    researchTemplate,
    "cd /TOKEN_PATH && claude -p '/market-research rutyna'",
    claudeCommand(ctx.path, "/market-research rutyna", ctx.platform),
  );

  return {
    layout: SOURCE_TEMPLATES.layout,
    profile,
    privacy:
      ctx.privacy === "amounts" ? SOURCE_TEMPLATES.privacyAmounts : SOURCE_TEMPLATES.privacyStrict,
    tools,
    boundaries,
    files: SOURCE_TEMPLATES.files,
    skills,
    research,
  };
}

export const userPart = SOURCE_TEMPLATES.userPart;
