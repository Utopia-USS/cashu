import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectorSchemaFiles,
  MANIFEST_SCHEMA_FILE,
  manifestJsonSchema,
  PROTOCOL_SCHEMA_FILE,
  protocolJsonSchema,
} from "./jsonSchemas.js";
import { manifestSchema } from "./manifest.js";
import { checkResponse, detectResponse, documentResponse, errorResponse } from "./runner.js";

const SCHEMAS = new URL("../../../../docs/schemas/", import.meta.url);

// The generated text is the committed file, byte for byte. When this fails run
// `pnpm --filter @cashu/host gen:connector-schemas`.
describe("docs/schemas", () => {
  it.each(connectorSchemaFiles().map((entry) => [entry.file, entry.text] as const))(
    "%s is generated, byte for byte",
    (file, text) => {
      const committed = readFileSync(fileURLToPath(new URL(file, SCHEMAS)), "utf8");
      expect(text === committed, `${file} is stale`).toBe(true);
    },
  );

  it("lists exactly the generated files", () => {
    expect(connectorSchemaFiles().map((entry) => entry.file)).toEqual([
      MANIFEST_SCHEMA_FILE,
      PROTOCOL_SCHEMA_FILE,
      "cashu-budget-import.v1.json",
      "cashu-import.v1.json",
    ]);
  });
});

type Node = { readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The validation keywords compared between the published schema and the zod model. */
const KEYWORDS = [
  "type",
  "const",
  "enum",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
] as const;

/**
 * The structure of a schema as `path keyword -> value` lines: per object its property names and
 * required list, per value its validation keywords; `$ref`s resolved, array items at `path[]`.
 * Normalised, because both spellings validate the same: `anyOf [x, null]` is `x` plus `nullable`, the
 * published `default: null` of a nullable field is zod's `.nullable().optional()`, and an open object
 * (`additionalProperties: true` / `{}`, zod's `propertyNames: {type: string}` on a record) is `open`.
 * Titles and descriptions are text, not structure.
 */
function structure(schema: Node, defs: Node = {}): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Node, path: string): void => {
    const target = typeof node.$ref === "string" ? defs[node.$ref.replace("#/$defs/", "")] : node;
    if (!isNode(target)) throw new Error(`unresolved schema at ${path}`);
    const anyOf = Array.isArray(target.anyOf) ? (target.anyOf as Node[]) : null;
    if (anyOf) {
      const values = anyOf.filter((option) => option.type !== "null");
      const [value] = values;
      if (values.length !== 1 || anyOf.length !== 2 || !value) throw new Error(`anyOf at ${path}`);
      out.set(`${path} nullable`, "true");
      if (target.default !== undefined && target.default !== null)
        out.set(`${path} default`, JSON.stringify(target.default));
      walk(value, path);
      return;
    }
    for (const keyword of KEYWORDS)
      if (target[keyword] !== undefined)
        out.set(`${path} ${keyword}`, JSON.stringify(target[keyword]));
    if (target.additionalProperties !== undefined) {
      const extra = target.additionalProperties;
      out.set(
        `${path} additionalProperties`,
        extra === false
          ? "closed"
          : isNode(extra) && Object.keys(extra).length > 0
            ? JSON.stringify(extra)
            : "open",
      );
    }
    if (isNode(target.properties)) {
      out.set(`${path} properties`, JSON.stringify(Object.keys(target.properties)));
      out.set(`${path} required`, JSON.stringify(target.required ?? []));
      for (const [name, property] of Object.entries(target.properties))
        if (isNode(property)) walk(property, `${path}.${name}`);
    }
    if (isNode(target.items)) walk(target.items, `${path}[]`);
  };
  walk(schema, "");
  return out;
}

/** The lines where the published schema and the zod model differ, as `line: published | zod`. */
function differences(published: Map<string, string>, model: Map<string, string>): string[] {
  const lines = [...new Set([...published.keys(), ...model.keys()])].sort();
  return lines
    .filter((line) => published.get(line) !== model.get(line))
    .map((line) => `${line}: ${published.get(line) ?? "-"} | ${model.get(line) ?? "-"}`);
}

const zodStructure = (schema: z.ZodType): Map<string, string> =>
  structure(z.toJSONSchema(schema, { io: "input" }) as Node);

describe("the published schemas match the zod models the app validates with", () => {
  it("connector.yaml: manifestSchema", () => {
    const published = manifestJsonSchema() as Node;
    // Known disagreements, kept as they are (the app's validation is not changed to match the file,
    // and the published contract is not tightened here). Each line: published | zod.
    expect(
      differences(structure(published, published.$defs as Node), zodStructure(manifestSchema)),
    ).toEqual([
      // zod's z.literal(1) is a JSON number; the file says integer (JSON cannot tell 1 from 1.0).
      '.api_version type: "integer" | "number"',
      // The app checks each host name is a lowercase DNS name; the file allows any string.
      '.fetch.hosts[] pattern: - | "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"',
      // z.iso.date() also checks the calendar (pattern); the file has format: date only.
      '.last_verified pattern: - | "^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))$"',
      // The app limits each run argument to 1..200 characters; the file allows any string.
      ".run[] maxLength: - | 200",
      ".run[] minLength: - | 1",
    ]);
    // Not expressible in either JSON form, enforced by the zod model only: name / label / version /
    // author / description / maintainer are trimmed before their length checks, `id` may not be
    // "catalog", and the superRefine rules the file's description lists (run[0], kind vs section,
    // unique fetch ids).
  });

  it("stdout: the detect / document / check / error responses", () => {
    const published = protocolJsonSchema() as Node;
    const defs = published.$defs as Node;
    const responses: readonly (readonly [string, z.ZodType])[] = [
      ["DetectResponse", detectResponse],
      ["DocumentResponse", documentResponse],
      ["CheckResponse", checkResponse],
      ["ErrorResponse", errorResponse],
    ];
    for (const [name, model] of responses)
      expect(differences(structure(defs[name] as Node, defs), zodStructure(model)), name).toEqual(
        [],
      );
    // The request (`Request`, `RequestFile`, `RequestAccount`) has no zod model: `runConnector` builds
    // it; runner.test.ts pins what it writes.
  });
});
