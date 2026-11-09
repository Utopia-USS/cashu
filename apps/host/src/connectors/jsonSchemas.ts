/**
 * The JSON Schemas connector authors (and their agents) validate against, as published in
 * `docs/schemas/`: the connector manifest (`connector.yaml`, checked by `manifestSchema` in
 * `manifest.ts`), the stdin / stdout protocol (the request `runConnector` writes, the responses
 * `parseResponse` reads in `runner.ts`), and the two import documents a connector returns (built in
 * `@cashu/domain`).
 *
 * The files keep the shape they were first published in (pydantic's: every field titled, schema keys
 * sorted, optional fields as `anyOf [value, null]` with `default: null`), so this module writes them out
 * instead of deriving them from the zod models; `jsonSchemas.test.ts` checks the files byte for byte and
 * cross-checks the structure against the zod models. `apps/host/scripts/genConnectorSchemas.ts` writes
 * them.
 */

import { BUDGET_IMPORT_SCHEMA_FILE, budgetImportSchemaText } from "@cashu/domain/budget";
import { IMPORT_SCHEMA_FILE, importSchemaText } from "@cashu/domain/investments/importing";

const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
export const MANIFEST_SCHEMA_FILE = "connector-manifest.v1.json";
export const PROTOCOL_SCHEMA_FILE = "connector-protocol.v1.json";
/** The error kinds a connector reports itself (the app adds its own: protocol, timeout, ...). */
const CONNECTOR_ERROR_KINDS = [
  "bad_file",
  "unsupported_version",
  "auth_failed",
  "rate_limited",
  "network",
  "upstream",
  "internal",
] as const;

type SchemaNode = { readonly [key: string]: unknown };

/** A JSON number the file prints with a fraction (`1.0`), as it was published. */
class FloatValue {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  toJSON(): number {
    return this.value;
  }
}

/** pydantic's field title: `timeout_s` -> `Timeout S`. */
const title = (name: string): string =>
  name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const STRING: SchemaNode = { type: "string" };
const ID: SchemaNode = { pattern: "^[a-z][a-z0-9_]{0,31}$", type: "string" };
const MODULES = ["investments", "budget"];
const text = (min: number, max: number): SchemaNode => ({
  maxLength: max,
  minLength: min,
  type: "string",
});
const ref = (definition: string): SchemaNode => ({ $ref: `#/$defs/${definition}` });

/** A field (required, or optional with a non-null `default` in `schema`). */
const field = (name: string, schema: SchemaNode, description?: string): SchemaNode => ({
  ...schema,
  ...(description === undefined ? {} : { description }),
  title: title(name),
});

/** An optional field: the value or null, null when absent. */
const optional = (name: string, schema: SchemaNode, description?: string): SchemaNode => ({
  anyOf: [schema, { type: "null" }],
  default: null,
  ...(description === undefined ? {} : { description }),
  title: title(name),
});

/** An optional nested model: the model or null, null when absent (untitled, as a reference). */
const optionalModel = (definition: string, description?: string): SchemaNode => ({
  anyOf: [ref(definition), { type: "null" }],
  default: null,
  ...(description === undefined ? {} : { description }),
});

const list = (name: string, items: SchemaNode, bounds: SchemaNode): SchemaNode =>
  field(name, { ...bounds, items, type: "array" });

/** A model: its properties in field order; `strict` forbids unknown keys. */
function model(
  name: string,
  options: { readonly description?: string; readonly strict: boolean },
  properties: Readonly<Record<string, SchemaNode>>,
  required: readonly string[],
): SchemaNode {
  return {
    ...(options.strict ? { additionalProperties: false } : {}),
    ...(options.description === undefined ? {} : { description: options.description }),
    properties,
    required: [...required],
    title: name,
    type: "object",
  };
}

/**
 * pydantic's key order: the keys of every schema object sorted, the keys of a `properties` map in
 * field order; `default` values are data and stay as they are.
 */
function sortedKeys(node: unknown, fieldMap = false): unknown {
  if (Array.isArray(node)) return node.map((item) => sortedKeys(item));
  if (node === null || typeof node !== "object" || node instanceof FloatValue) return node;
  const entries = Object.entries(node);
  if (!fieldMap) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      key === "default" && !fieldMap ? value : sortedKeys(value, key === "properties" && !fieldMap),
    ]),
  );
}

/** The `connector.yaml` JSON Schema as an object (key order is the file's). */
export function manifestJsonSchema(): SchemaNode {
  const defs = {
    FetchSpec: model(
      "FetchSpec",
      {
        description:
          "``kind: fetch``: the hosts the egress proxy allows (port 443 only), secrets and params.",
        strict: true,
      },
      {
        hosts: list("hosts", STRING, { maxItems: 10, minItems: 1 }),
        secrets: list("secrets", ref("SecretSpec"), { default: [], maxItems: 5 }),
        params: list("params", ref("ParamSpec"), { default: [], maxItems: 10 }),
        history_days: field("history_days", {
          default: 365,
          maximum: 3650,
          minimum: 1,
          type: "integer",
        }),
      },
      ["hosts"],
    ),
    FileSpec: model(
      "FileSpec",
      {
        description: "``kind: file``: the export file extensions the connector converts.",
        strict: true,
      },
      {
        extensions: list(
          "extensions",
          { pattern: "^[a-z0-9]{1,10}$", type: "string" },
          { maxItems: 20, minItems: 1 },
        ),
      },
      ["extensions"],
    ),
    ParamSpec: model(
      "ParamSpec",
      { description: "A non-secret setting of a binding.", strict: true },
      {
        id: field("id", ID),
        label: field("label", text(1, 60)),
        type: field("type", {
          default: "string",
          enum: ["string", "date", "number", "boolean"],
          type: "string",
        }),
        required: field("required", { default: false, type: "boolean" }),
      },
      ["id", "label"],
    ),
    SecretSpec: model(
      "SecretSpec",
      {
        description:
          "A secret the owner enters once per binding (stored in the OS keychain, given only on stdin).",
        strict: true,
      },
      { id: field("id", ID), label: field("label", text(1, 60)) },
      ["id", "label"],
    ),
  };
  const manifest = model(
    "Manifest",
    { strict: true },
    {
      api_version: field("api_version", { const: 1, type: "integer" }),
      id: field("id", { pattern: "^[a-z][a-z0-9-]{1,39}$", type: "string" }),
      name: field("name", text(1, 60)),
      version: field("version", text(1, 20)),
      author: optional("author", text(1, 80)),
      description: optional("description", text(1, 280)),
      maintainer: optional("maintainer", text(1, 80)),
      last_verified: optional("last_verified", { format: "date", type: "string" }),
      countries: optional(
        "countries",
        {
          items: { pattern: "^[A-Z]{2}$", type: "string" },
          maxItems: 60,
          minItems: 1,
          type: "array",
        },
        "ISO 3166-1 alpha-2 codes of the countries whose banks or users this source serves; absent for a source not tied to a country (an international broker or exchange).",
      ),
      module: field("module", { enum: MODULES, type: "string" }),
      kind: field("kind", { enum: ["file", "fetch"], type: "string" }),
      run: list("run", STRING, { maxItems: 8, minItems: 1 }),
      timeout_s: field("timeout_s", { default: 60, maximum: 600, minimum: 1, type: "integer" }),
      file: optionalModel("FileSpec"),
      fetch: optionalModel("FetchSpec"),
    },
    ["api_version", "id", "name", "version", "module", "kind", "run"],
  );
  // The model's own title is replaced by the published one below.
  const { title: _title, ...body } = manifest;
  return {
    $schema: SCHEMA_DRAFT,
    $id: MANIFEST_SCHEMA_FILE,
    title: "cashU connector manifest (connector.yaml), api_version 1",
    description:
      "Generated from the connector manifest model (apps/host/src/connectors/manifest.ts) by apps/host/scripts/genConnectorSchemas.ts; see docs/connectors.md. The app also enforces the rules a schema cannot express: run[0] is an allowed interpreter or ./<file>, no `..` or absolute paths in run, the file / fetch section matches kind, unique ids, directory limits.",
    ...(sortedKeys({ $defs: defs, ...body }) as SchemaNode),
  };
}

/** The protocol messages, by their name in the file, with the model each one is. */
const MESSAGES = [
  ["request", "Request"],
  ["detect_response", "DetectResponse"],
  ["document_response", "DocumentResponse"],
  ["check_response", "CheckResponse"],
  ["error_response", "ErrorResponse"],
] as const;

/** The connector protocol JSON Schema as an object (key order is the file's). */
export function protocolJsonSchema(): SchemaNode {
  const defs = {
    CheckResponse: model(
      "CheckResponse",
      { strict: true },
      { ok: field("ok", { const: true, type: "boolean" }) },
      ["ok"],
    ),
    DetectResponse: model(
      "DetectResponse",
      { strict: true },
      {
        match: field("match", { type: "boolean" }),
        confidence: field("confidence", {
          default: new FloatValue(1),
          maximum: 1,
          minimum: 0,
          type: "number",
        }),
      },
      ["match"],
    ),
    DocumentResponse: model(
      "DocumentResponse",
      {
        description: "``convert`` / ``fetch``: the import document in the module's format.",
        strict: true,
      },
      {
        document: field(
          "document",
          { additionalProperties: true, type: "object" },
          "investments: cashu-import v1 JSON; budget: cashu-budget-import v1 JSON.",
        ),
        cursor: optional(
          "cursor",
          { maxLength: 4096, type: "string" },
          "fetch only: opaque state handed back on the next fetch.",
        ),
      },
      ["document"],
    ),
    ErrorDetail: model(
      "ErrorDetail",
      { strict: true },
      {
        kind: field("kind", { pattern: "^[a-z][a-z0-9_]{0,39}$", type: "string" }),
        message: field("message", { default: "", type: "string" }),
      },
      ["kind"],
    ),
    ErrorResponse: model(
      "ErrorResponse",
      {
        description:
          "Exit code 1. ``message`` is shown to the owner only (it may contain data), never to MCP.",
        strict: true,
      },
      { error: ref("ErrorDetail") },
      ["error"],
    ),
    Request: model(
      "Request",
      { description: "What the app writes to the connector's stdin.", strict: false },
      {
        api_version: field("api_version", { const: 1, default: 1, type: "integer" }),
        command: field("command", {
          enum: ["detect", "convert", "fetch", "check"],
          type: "string",
        }),
        module: field("module", { enum: MODULES, type: "string" }),
        file: optionalModel("RequestFile", "detect / convert only."),
        account: optionalModel("RequestAccount"),
        params: field("params", { additionalProperties: true, type: "object" }),
        secrets: optional(
          "secrets",
          { additionalProperties: STRING, type: "object" },
          "fetch / check only.",
        ),
        since: optional("since", STRING, "fetch only: YYYY-MM-DD."),
        cursor: optional("cursor", STRING, "fetch only: opaque, from the last fetch."),
      },
      ["command", "module"],
    ),
    RequestAccount: model(
      "RequestAccount",
      { strict: false },
      {
        currency: field("currency", STRING, "ISO 4217 currency of the target account."),
        label: field("label", STRING, "The account's display name."),
      },
      ["currency", "label"],
    ),
    RequestFile: model(
      "RequestFile",
      { strict: false },
      {
        path: field("path", STRING, "Absolute path of the input copy inside the run directory."),
        name: field("name", STRING, "The original file name (never its original location)."),
      },
      ["path", "name"],
    ),
  };
  return {
    $schema: SCHEMA_DRAFT,
    $id: PROTOCOL_SCHEMA_FILE,
    title: "cashU connector protocol, api_version 1",
    description: `Generated from the connector protocol (apps/host/src/connectors/runner.ts) by apps/host/scripts/genConnectorSchemas.ts; see docs/connectors.md. stdin: request. stdout with exit code 0: detect_response (detect), document_response (convert, fetch), check_response (check); with exit code 1: error_response. Known error kinds: ${CONNECTOR_ERROR_KINDS.join(", ")}.`,
    messages: Object.fromEntries(MESSAGES.map(([name, definition]) => [name, ref(definition)])),
    $defs: sortedKeys(defs),
  };
}

/**
 * The file text of a schema: two-space indent, a final newline, and a `FloatValue` printed with its
 * fraction (`1.0`), the one place where the published bytes differ from `JSON.stringify`.
 */
function renderJsonSchema(schema: SchemaNode): string {
  const render = (value: unknown, indent: string): string => {
    if (value instanceof FloatValue)
      return Number.isInteger(value.value) ? value.value.toFixed(1) : String(value.value);
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const inner = `${indent}  `;
      return `[\n${value.map((item) => `${inner}${render(item, inner)}`).join(",\n")}\n${indent}]`;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) return "{}";
      const inner = `${indent}  `;
      const lines = entries.map(
        ([key, item]) => `${inner}${JSON.stringify(key)}: ${render(item, inner)}`,
      );
      return `{\n${lines.join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${render(schema, "")}\n`;
}

/** Every published schema file of `docs/schemas/` with its text, in the generator's order. */
export function connectorSchemaFiles(): readonly {
  readonly file: string;
  readonly text: string;
}[] {
  return [
    { file: MANIFEST_SCHEMA_FILE, text: renderJsonSchema(manifestJsonSchema()) },
    { file: PROTOCOL_SCHEMA_FILE, text: renderJsonSchema(protocolJsonSchema()) },
    { file: BUDGET_IMPORT_SCHEMA_FILE, text: budgetImportSchemaText() },
    { file: IMPORT_SCHEMA_FILE, text: importSchemaText() },
  ];
}
