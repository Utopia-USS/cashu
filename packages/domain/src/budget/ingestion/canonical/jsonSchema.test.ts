/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/fixtures.js";
import { ACCOUNT_FIELDS, BALANCE_FIELDS, TOP_LEVEL_KEYS, TRANSACTION_FIELDS } from "./constants.js";
import {
  BUDGET_IMPORT_SCHEMA_FILE,
  budgetImportSchema,
  budgetImportSchemaText,
} from "./jsonSchema.js";

// The schema built from the validator's tables is the committed file, byte for byte. When this fails
// run `pnpm --filter @cashu/host gen:connector-schemas`.
describe("docs/schemas/cashu-budget-import.v1.json", () => {
  const committed = readFileSync(
    join(REPO_ROOT, "docs", "schemas", BUDGET_IMPORT_SCHEMA_FILE),
    "utf8",
  );

  it("is generated from the validator's tables, byte for byte", () => {
    expect(budgetImportSchemaText() === committed, "the committed schema is stale").toBe(true);
  });

  it("lists the fields of every model in the validator's order", () => {
    const schema = budgetImportSchema() as {
      properties: Record<string, unknown>;
      $defs: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(Object.keys(schema.properties)).toEqual([...TOP_LEVEL_KEYS]);
    expect(Object.keys(schema.$defs.DocAccount?.properties ?? {})).toEqual([...ACCOUNT_FIELDS]);
    expect(Object.keys(schema.$defs.DocBalance?.properties ?? {})).toEqual([...BALANCE_FIELDS]);
    expect(Object.keys(schema.$defs.DocTransaction?.properties ?? {})).toEqual([
      ...TRANSACTION_FIELDS,
    ]);
  });
});
