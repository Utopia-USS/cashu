/**
 * Writes `src/investments/strategy/templates.data.ts` from the shipped strategy templates of the Python
 * app (`src/cashu/modules/investments/templates/strategy/`), the files' source of truth until the
 * Python module retires. The domain cannot read files, so the texts are embedded:
 *
 *     pnpm --filter @cashu/domain gen:strategy-templates            # write the data file
 *     pnpm --filter @cashu/domain gen:strategy-templates --check    # exit 1 when it is stale
 *
 * The test `strategy/templates.test.ts` runs the same check on every `pnpm test`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strategyTemplatesSource, TEMPLATE_SOURCE_DIR } from "./strategyTemplateSource.ts";

const target = fileURLToPath(
  new URL("../src/investments/strategy/templates.data.ts", import.meta.url),
);
const wanted = strategyTemplatesSource();
const current = existsSync(target) ? readFileSync(target, "utf8") : null;

if (current === wanted) process.exit(0);
if (process.argv.includes("--check")) {
  process.stderr.write(
    `Stale strategy templates (run \`pnpm --filter @cashu/domain gen:strategy-templates\`) from ${TEMPLATE_SOURCE_DIR}\n`,
  );
  process.exit(1);
}
writeFileSync(target, wanted, "utf8");
process.stdout.write("updated src/investments/strategy/templates.data.ts\n");
