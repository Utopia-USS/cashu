/**
 * The reference copies inside the shipped skills (`.claude/skills/<skill>/references/`). Skills leave the
 * repository (`cashu skills install`, the per-profile agent workspaces, the packaged app), so a skill
 * never points at repository files: the docs it needs are copied into its own `references/` folder, with
 * repository paths rewritten to the copies' names. `apps/host/scripts/syncSkillReferences.ts` writes
 * them; `skillReferences.test.ts` fails when one is stale.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strategyReference, strategyTemplate } from "@cashu/domain/investments/strategy";

const EXPRESSIONS = "packages/domain/src/investments/rules/expr/EXPRESSIONS.md";
const GENERIC_CSV = "packages/domain/src/investments/importing/generic_csv_example.yaml";
const TEMPLATES_TEST = "packages/domain/src/investments/strategy/templates.test.ts";
const EXAMPLES = "examples/connectors";
const CONNECTOR_EXAMPLES = ["budget-csv-example", "investments-json-example", "fetch-example"];
const DENO_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  "deno-budget-example": ["connector.yaml", "connector.ts", "parse.ts"],
};
const SCHEMAS = [
  "connector-manifest.v1.json",
  "connector-protocol.v1.json",
  "cashu-budget-import.v1.json",
  "cashu-import.v1.json",
];

/** Where a copy's text comes from: a repository file, or text the domain embeds. */
type Source = { readonly file: string } | { readonly text: () => string };

const file = (path: string): Source => ({ file: path });
const template = (name: string, part: "yaml" | "markdown"): Source => ({
  text: () => strategyTemplate(name)?.[part] ?? "",
});

/** (skill, file inside the skill, source). */
const COPIES: readonly (readonly [string, string, Source])[] = [
  ["investments-setup", "references/strategy-schema.md", { text: strategyReference }],
  ["investments-setup", "references/expressions.md", file(EXPRESSIONS)],
  ["investments-setup", "references/templates/passive_etf.yaml", template("passive_etf", "yaml")],
  ["investments-setup", "references/templates/blank.yaml", template("blank", "yaml")],
  ["extension-builder", "references/strategy-schema.md", { text: strategyReference }],
  ["extension-builder", "references/expressions.md", file(EXPRESSIONS)],
  ["import-builder", "references/import-format.md", file("docs/import-format.md")],
  ["import-builder", "references/generic_csv_example.yaml", file(GENERIC_CSV)],
  ["import-builder", "references/connectors.md", file("docs/connectors.md")],
  ["import-builder", "references/budget-import-format.md", file("docs/budget-import-format.md")],
  ...SCHEMAS.map(
    (name) =>
      ["import-builder", `references/schemas/${name}`, file(`docs/schemas/${name}`)] as const,
  ),
  ...CONNECTOR_EXAMPLES.flatMap((example) =>
    ["connector.yaml", "connector.py"].map(
      (name) =>
        [
          "import-builder",
          `references/connector-examples/${example}/${name}`,
          file(`${EXAMPLES}/${example}/${name}`),
        ] as const,
    ),
  ),
  ...Object.entries(DENO_EXAMPLES).flatMap(([example, names]) =>
    names.map(
      (name) =>
        [
          "import-builder",
          `references/connector-examples/${example}/${name}`,
          file(`${EXAMPLES}/${example}/${name}`),
        ] as const,
    ),
  ),
];

/** Repository paths inside the sources -> what the copy calls them (copies sit side by side). */
const REWRITES: readonly (readonly [string, string])[] = [
  [`\`${EXPRESSIONS}\``, "`expressions.md`"],
  [EXPRESSIONS, "expressions.md"],
  [`\`${GENERIC_CSV}\``, "`generic_csv_example.yaml`"],
  [GENERIC_CSV, "generic_csv_example.yaml"],
  [`\`${TEMPLATES_TEST}\``, "the cashU test suite"],
  [`../${EXAMPLES}/`, "connector-examples/"],
  [`${EXAMPLES}/`, "connector-examples/"],
  ["docs/import-format.md", "import-format.md"],
  ["docs/budget-import-format.md", "budget-import-format.md"],
  ["docs/connectors.md", "connectors.md"],
];

const NOTE = "Copy shipped with this skill, generated from the cashU sources; do not edit it here.";

function render(text: string, dest: string): string {
  let out = text;
  for (const [from, to] of REWRITES) out = out.replaceAll(from, to);
  // JSON has no comments: copied verbatim (its $id / description name the source).
  if (dest.endsWith(".json")) return out;
  if (dest.endsWith(".md")) return `<!-- ${NOTE} -->\n\n${out}`;
  if (dest.endsWith(".ts") || dest.endsWith(".js")) return `// ${NOTE}\n${out}`;
  return `# ${NOTE}\n${out}`;
}

export interface SkillReferenceCopy {
  /** Path of the copy relative to the repository root. */
  readonly path: string;
  /** Its wanted text. */
  readonly text: string;
}

/** Every reference copy of the checkout `root` with its wanted text. */
export function skillReferenceCopies(root: string): SkillReferenceCopy[] {
  return COPIES.map(([skill, dest, source]) => ({
    path: join(".claude", "skills", skill, dest),
    text: render(
      "file" in source ? readFileSync(join(root, source.file), "utf8") : source.text(),
      dest,
    ),
  }));
}
