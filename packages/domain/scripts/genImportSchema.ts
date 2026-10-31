/**
 * Writes `docs/schemas/cashu-import.v1.json` from the TypeScript field tables (the twin of
 * `scripts/gen_connector_schemas.py` for this one file; the other three schemas stay generated from the
 * Python models until their scopes are ported):
 *
 *     pnpm --filter @cashu/domain gen:import-schema            # write the schema
 *     pnpm --filter @cashu/domain gen:import-schema --check    # exit 1 when the file is stale
 *
 * The test `importing/jsonSchema.test.ts` runs the same check on every `pnpm test`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IMPORT_SCHEMA_FILE, importSchemaText } from "../src/investments/importing/jsonSchema.ts";

const target = fileURLToPath(
  new URL(`../../../docs/schemas/${IMPORT_SCHEMA_FILE}`, import.meta.url),
);
const wanted = importSchemaText();
const current = existsSync(target) ? readFileSync(target, "utf8") : null;

if (current === wanted) {
  process.exit(0);
}
if (process.argv.includes("--check")) {
  process.stderr.write(
    `Stale schema (run \`pnpm --filter @cashu/domain gen:import-schema\`): ${IMPORT_SCHEMA_FILE}\n`,
  );
  process.exit(1);
}
writeFileSync(target, wanted, "utf8");
process.stdout.write(`updated docs/schemas/${IMPORT_SCHEMA_FILE}\n`);
