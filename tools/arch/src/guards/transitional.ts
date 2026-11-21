// Strangler shims and other temporary code are marked `TRANSITIONAL(<scope that removes it>)` so they
// stay visible until that scope removes them. `arch:check` reports every marker by scope, and the guard
// test fails when a marker names a scope that is not live: the ids of the plan of record that are in
// flight, queued, planned or on hold, plus external upstream conditions, are listed in
// tools/arch/scopes.json. A done or unknown id means the marker outlived its scope (remove the code)
// or names the wrong one (re-point it).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listFiles, REPO_ROOT, readRepoFile } from "../repo.ts";

export interface TransitionalMarker {
  file: string;
  line: number;
  scope: string;
  text: string;
}

// The scope is a name (S30, arch-tools); `TRANSITIONAL(<scope>)` in docs is the syntax, not a marker.
const MARKER = /TRANSITIONAL\(([A-Za-z0-9][\w .:-]*)\)\s*:?\s*(.*)$/;

export function findMarkers(file: string, source: string): TransitionalMarker[] {
  const out: TransitionalMarker[] = [];
  source.split("\n").forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m)
      out.push({
        file,
        line: i + 1,
        scope: (m[1] ?? "").trim() || "?",
        text: (m[2] ?? "").trim().slice(0, 100),
      });
  });
  return out;
}

/**
 * Every marker in the repo: the TS monorepo and its tooling, the pnpm patches and the docs (this
 * file and its test excluded).
 */
export function transitionalMarkers(): TransitionalMarker[] {
  const files = listFiles(
    ["packages", "apps", "tools", ".github", "patches", "docs"],
    /\.(ts|tsx|cts|mts|js|mjs|cjs|json|jsonc|yaml|yml|sh|md|py|patch)$/,
  ).filter(
    (f) =>
      !f.endsWith("tools/arch/src/guards/transitional.ts") && !f.endsWith("transitional.test.ts"),
  );
  const rootFiles = [
    "package.json",
    "pnpm-workspace.yaml",
    "biome.json",
    "turbo.json",
    "tsconfig.base.json",
  ];
  return [...rootFiles.filter((f) => existsSync(join(REPO_ROOT, f))), ...files].flatMap((f) =>
    findMarkers(f, readRepoFile(f)),
  );
}

/** The live scope registry (tools/arch/scopes.json). */
export interface ScopeRegistry {
  /** Scope ids of the plan of record that are in flight, queued, planned or on hold. */
  live: Record<string, string>;
  /** Upstream conditions (a tool or platform release) that end a marker, not a scope of ours. */
  external: Record<string, string>;
}

const SCOPE_REGISTRY = "tools/arch/scopes.json";

export function scopeRegistry(): ScopeRegistry {
  const raw = JSON.parse(readRepoFile(SCOPE_REGISTRY)) as Partial<ScopeRegistry>;
  return { live: raw.live ?? {}, external: raw.external ?? {} };
}

function isLiveScope(scope: string, registry: ScopeRegistry): boolean {
  return Object.hasOwn(registry.live, scope) || Object.hasOwn(registry.external, scope);
}

/** Markers whose scope is done, dropped or unknown: each is a guard failure. */
export function deadMarkers(
  markers: readonly TransitionalMarker[],
  registry: ScopeRegistry,
): TransitionalMarker[] {
  return markers.filter((m) => !isLiveScope(m.scope, registry));
}

export function formatMarkers(
  markers: readonly TransitionalMarker[],
  registry?: ScopeRegistry,
): string {
  if (!markers.length) return "no TRANSITIONAL( markers";
  const byScope = new Map<string, TransitionalMarker[]>();
  for (const m of markers) byScope.set(m.scope, [...(byScope.get(m.scope) ?? []), m]);
  const lines = [`${markers.length} TRANSITIONAL( marker(s), by the scope that removes them:`];
  for (const [scope, ms] of [...byScope].sort()) {
    const dead = registry && !isLiveScope(scope, registry) ? `  NOT LIVE in ${SCOPE_REGISTRY}` : "";
    lines.push(`  ${scope} (${ms.length})${dead}`);
    for (const m of ms) lines.push(`    ${m.file}:${m.line}  ${m.text}`);
  }
  return lines.join("\n");
}
