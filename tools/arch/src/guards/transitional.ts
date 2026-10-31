// Report (never a failure): strangler shims and other temporary code are marked
// `TRANSITIONAL(<scope that removes it>)` so they stay visible until that scope removes them.
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

/** Every marker in the TS monorepo and its tooling (the definition in this file excluded). */
export function transitionalMarkers(): TransitionalMarker[] {
  const files = listFiles(
    ["packages", "apps", "tools", ".github"],
    /\.(ts|tsx|cts|mts|js|mjs|cjs|json|jsonc|yaml|yml|sh|md)$/,
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

export function formatMarkers(markers: readonly TransitionalMarker[]): string {
  if (!markers.length) return "no TRANSITIONAL( markers";
  const byScope = new Map<string, TransitionalMarker[]>();
  for (const m of markers) byScope.set(m.scope, [...(byScope.get(m.scope) ?? []), m]);
  const lines = [`${markers.length} TRANSITIONAL( marker(s), by the scope that removes them:`];
  for (const [scope, ms] of [...byScope].sort()) {
    lines.push(`  ${scope} (${ms.length})`);
    for (const m of ms) lines.push(`    ${m.file}:${m.line}  ${m.text}`);
  }
  return lines.join("\n");
}
