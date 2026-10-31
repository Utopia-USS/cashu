/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, RECORD_FIELDS, RECORD_KINDS } from "./canonical/index.js";
import { IMPORT_SCHEMA_FILE, importSchema, importSchemaText } from "./jsonSchema.js";
import { REPO_ROOT } from "./testing/support.js";

// The TypeScript twin of `scripts/gen_connector_schemas.py --check` for docs/schemas/cashu-import.v1.json:
// the schema built from the importer's field tables is the committed file, byte for byte. When this
// fails run `pnpm --filter @cashu/domain gen:import-schema` (and the Python generator, until it is gone).
describe("docs/schemas/cashu-import.v1.json", () => {
  const committed = readFileSync(join(REPO_ROOT, "docs", "schemas", IMPORT_SCHEMA_FILE), "utf8");

  it("is generated from the field tables, byte for byte", () => {
    expect(importSchemaText() === committed, "the committed schema is stale").toBe(true);
  });

  it("lists every record field and allows each field only in its record kinds", () => {
    const schema = importSchema() as {
      $defs: {
        record: {
          properties: Record<string, unknown>;
          allOf: { then: { propertyNames: { enum: string[] } } }[];
        };
      };
    };
    expect(Object.keys(schema.$defs.record.properties)).toEqual([...RECORD_FIELDS.keys()]);
    const perKind = schema.$defs.record.allOf.map((rule) => rule.then.propertyNames.enum);
    expect(perKind).toHaveLength(RECORD_KINDS.length);
    RECORD_KINDS.forEach((kind, index) => {
      const want = [...RECORD_FIELDS].filter(([, kinds]) => kinds.has(kind)).map(([name]) => name);
      expect(perKind[index]).toEqual(want);
    });
  });

  it("names the columns the CSV variant shares with the document", () => {
    const text = importSchemaText();
    for (const column of CSV_COLUMNS) {
      if (column === "format_version" || column === "source" || column === "account_hint") continue;
      expect(text, column).toContain(`"${column}"`);
    }
  });
});
