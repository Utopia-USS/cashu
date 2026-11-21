/**
 * Writes the reference copies inside the shipped skills (`.claude/skills/<skill>/references/`) from
 * their sources (docs, schemas, connector examples, the domain's strategy templates and expression
 * reference). Run after editing one of the sources:
 *
 *     pnpm --filter @cashu/host skills:sync            # write the copies
 *     pnpm --filter @cashu/host skills:sync --check    # exit 1 when a copy is stale
 *
 * `src/workspace/skillReferences.test.ts` runs the same check on every `pnpm test`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillReferenceCopies } from "../src/workspace/skillReferences.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const { path, text } of skillReferenceCopies(root)) {
  const target = join(root, path);
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  stale.push(path);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
    process.stdout.write(`updated ${path}\n`);
  }
}
if (check && stale.length > 0) {
  process.stderr.write(
    `Stale skill reference copies (run \`pnpm --filter @cashu/host skills:sync\`): ${stale.join(", ")}\n`,
  );
  process.exit(1);
}
