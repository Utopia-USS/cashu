/**
 * Writes the connector JSON Schemas of `docs/schemas/` (the connector manifest, the connector protocol
 * and the two import documents) from the TypeScript models:
 *
 *     pnpm --filter @cashu/host gen:connector-schemas            # write the schemas
 *     pnpm --filter @cashu/host gen:connector-schemas --check    # exit 1 when a schema is stale
 *
 * `src/connectors/jsonSchemas.test.ts` runs the same check on every `pnpm test`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectorSchemaFiles } from "../src/connectors/jsonSchemas.ts";

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const { file, text } of connectorSchemaFiles()) {
  const target = fileURLToPath(new URL(`../../../docs/schemas/${file}`, import.meta.url));
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === text) continue;
  stale.push(file);
  if (!check) {
    writeFileSync(target, text, "utf8");
    process.stdout.write(`updated docs/schemas/${file}\n`);
  }
}
if (check && stale.length > 0) {
  process.stderr.write(
    `Stale connector schemas (run \`pnpm --filter @cashu/host gen:connector-schemas\`): ${stale.join(", ")}\n`,
  );
  process.exit(1);
}
