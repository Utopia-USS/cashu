/**
 * `@cashu/domain/core/workspace`: the agent workspace plan (shipped skills per module, managed CLAUDE.md
 * sections, `.mcp.json` and settings rules). Its own subpath, not part of `@cashu/domain/core`: the
 * templates are large and only the local host renders a workspace, so the phone (Metro does not
 * tree-shake) never bundles them.
 */
export * from "./plan.js";
export * from "./render.js";
