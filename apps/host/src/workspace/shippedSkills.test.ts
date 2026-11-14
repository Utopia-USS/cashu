// The shipped product skills (`.claude/skills/<skill>/`) leave the repository: they are copied into
// every profile's agent workspace and bundled in the packaged app. These checks keep each one
// registered, in the utopia-ai-arch:layer shape, self-contained and free of anything only a source
// checkout can run. Ported from the retired Python suite (tests/test_workspace.py).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MODULE_IDS } from "@cashu/domain/core";
import { MODULE_SKILLS, type SkillSource, wantedSkills } from "@cashu/domain/core/workspace";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { portedCommands } from "../cli/ported.js";
import { readSkillSource } from "./skills.js";

const REPO = resolve(import.meta.dirname, "../../../..");
const SKILLS = join(REPO, ".claude", "skills");

const shipped = readdirSync(SKILLS)
  .filter((name) => existsSync(join(SKILLS, name, "SKILL.md")))
  .sort();

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .map((name) => join(folder, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

/** Every skill name the registry knows, shipped or not: core skills plus `MODULE_SKILLS`. */
function registered(): Map<string, string> {
  // A source map that answers every name, so `wantedSkills` lists the registry, not the folders.
  class Everything extends Map<string, SkillSource> {
    override get(name: string): SkillSource {
      return { name, version: "", positive: "", negative: "" };
    }
  }
  const everything = new Everything();
  const out = new Map<string, string>();
  for (const skill of wantedSkills(MODULE_IDS, everything)) out.set(skill.name, skill.module);
  return out;
}

describe("shipped skills", () => {
  test("there are shipped skills", () => {
    expect(shipped.length).toBeGreaterThan(5);
  });

  test("every skill folder is registered and every registered skill ships", () => {
    expect([...registered().keys()].sort()).toEqual(shipped);
  });

  test("every module that brings skills is a built-in module", () => {
    expect(
      Object.keys(MODULE_SKILLS).filter((id) => !(MODULE_IDS as readonly string[]).includes(id)),
    ).toEqual([]);
  });

  test("every shipped skill follows the layer shape", () => {
    // utopia-ai-arch:layer: every shipped skill states where it applies and where it does not (the
    // workspace CLAUDE.md inventory shows both), within the 1024-character description Codex accepts,
    // and has a References table, See also and a self-audit.
    const problems: string[] = [];
    for (const name of shipped) {
      const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
      const meta = (head === undefined ? null : parse(head)) as {
        name?: unknown;
        description?: unknown;
      } | null;
      if (meta?.name !== name) problems.push(`${name}: frontmatter name ${String(meta?.name)}`);
      const description = typeof meta?.description === "string" ? meta.description : "";
      if (description === "") problems.push(`${name}: no description`);
      if (description.length > 1024)
        problems.push(`${name}: description longer than 1024 characters`);
      const source = readSkillSource(SKILLS, name);
      if (!source?.positive || !source.negative.startsWith("NOT "))
        problems.push(`${name}: no POSITIVE / NEGATIVE applicability`);
      for (const heading of ["## References", "## See also", "## Self-audit checklist"])
        if (!text.includes(`\n${heading}\n`)) problems.push(`${name}: no "${heading}" section`);
      // A skill that ships more than SKILL.md maps those files in a table; a single-file skill says so.
      const references = (text.split("\n## References\n")[1]?.split("\n## ")[0] ?? "").trim();
      const singleFile = filesUnder(join(SKILLS, name)).length === 1;
      const table = /^\|.*\|\s*$/m.test(references) && /^\|\s*:?-{3,}/m.test(references);
      if (singleFile ? references === "" : !table)
        problems.push(`${name}: the References section has no table`);
    }
    expect(problems).toEqual([]);
  });

  test("every references/... a skill names exists in its folder", () => {
    const missing: string[] = [];
    let resolved = 0;
    for (const name of shipped) {
      const folder = join(SKILLS, name);
      const references = join(folder, "references");
      const docs = [
        join(folder, "SKILL.md"),
        ...(existsSync(references) ? filesUnder(references).filter((p) => p.endsWith(".md")) : []),
      ];
      for (const doc of docs) {
        const text = readFileSync(doc, "utf8");
        const named = [
          ...text.matchAll(/`(references\/[A-Za-z0-9_./*<>-]+)`/g),
          ...text.matchAll(/\]\((references\/[^)\s#]+)(?:#[^)]*)?\)/g),
        ].map((match) => match[1] as string);
        for (const ref of named) {
          if (ref.includes("*") || ref.includes("<")) continue;
          if (existsSync(join(folder, ref))) resolved += 1;
          else missing.push(`${relative(SKILLS, doc)}: ${ref}`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
    expect(resolved).toBeGreaterThan(50);
  });

  // Text a user workspace cannot use: files of a source checkout (`AGENTS.md` and `CLAUDE.md` are
  // fine: every workspace has them), imports of cashU's own code and source-checkout tooling.
  // JSON is not scanned: schemas are copied verbatim and their $id / description name the source.
  const REPO_ONLY = new RegExp(
    [
      "src/cashu/",
      String.raw`\b(?:packages|apps)/[a-z0-9-]+/`,
      String.raw`\bdocs/[A-Za-z0-9_./-]+\.(?:md|json|ya?ml)\b`,
      String.raw`\btests/[a-z_/]+\.py\b`,
      String.raw`[A-Za-z0-9_]\.test\.ts\b`,
      String.raw`ONBOARDING\.md`,
      String.raw`\bfrom cashu(?:\.| import)|\bimport cashu\b`,
      String.raw`\bfrom ["']@cashu/|\bimport\s*\(?\s*["']@cashu/|require\(["']@cashu/`,
      String.raw`\.venv/|\bpython3? -m cashu\b|\bpip install -e\b|\bpytest\b|\bpnpm\b`,
    ].join("|"),
  );

  test("skills reference no repository files or source-checkout commands", () => {
    const offending: string[] = [];
    for (const path of filesUnder(SKILLS)) {
      if (!/\.(?:md|py|ya?ml|ts|js)$/.test(path)) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (REPO_ONLY.test(line))
            offending.push(`${relative(SKILLS, path)}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offending).toEqual([]);
  });

  test("every `cashu <command>` a skill names is a command of the native CLI", () => {
    const stub = {} as never;
    const commands = new Set([
      ...portedCommands({
        nativeStores: stub,
        deviceStores: stub,
        investmentSources: stub,
        performance: stub,
        worker: () => null,
        connectors: stub,
        banking: stub,
      }).map((command) => command.name),
      // Routed by the `cashu` shim before the host's command tree (apps/cli/src/route.ts).
      "app",
      "host",
      "mcp",
    ]);
    const unknown: string[] = [];
    let checked = 0;
    for (const path of filesUnder(SKILLS)) {
      if (!path.endsWith(".md")) continue;
      const text = readFileSync(path, "utf8");
      const invocations = [
        ...[...text.matchAll(/`cashu ([^`]+)`/g)].map((match) => match[1] as string),
        ...text
          .split("\n")
          .map((line) => /^\s*(?:\$ )?cashu (.+)$/.exec(line)?.[1])
          .filter((rest): rest is string => rest !== undefined),
      ];
      for (const rest of invocations) {
        const tokens = rest.trim().split(/\s+/);
        let i = 0;
        while (i < tokens.length) {
          const token = tokens[i] as string;
          if (token === "--profile" || token === "-p") i += 2;
          else if (token.startsWith("--profile=") || /^-p[^-]/.test(token)) i += 1;
          else break;
        }
        const name = tokens[i];
        if (name === undefined || name.startsWith("-") || /[<.]/.test(name)) continue;
        checked += 1;
        if (!commands.has(name)) unknown.push(`${relative(SKILLS, path)}: cashu ${rest}`);
      }
    }
    expect(unknown).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });
});
