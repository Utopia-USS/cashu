/** The structured-output JSON schemas sent with each request (`local_llm._schema`, `llm._build_schema`). */

import { OTHER, UNKNOWN } from "./prompts.js";

/** `local_llm._schema`: Ollama's `format` (enum = keys + `other`). */
export function ollamaSchema(categoryKeys: readonly string[]): unknown {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: [...categoryKeys, OTHER] },
            confidence: { type: "number" },
          },
          required: ["id", "category"],
        },
      },
    },
    required: ["results"],
  };
}

/** `llm._build_schema`: Anthropic's `output_config.format.schema` (enum = keys + `other` + `UNKNOWN`). */
export function anthropicSchema(categoryKeys: readonly string[]): unknown {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: [...categoryKeys, OTHER, UNKNOWN] },
            confidence: { type: "number" },
          },
          required: ["id", "category", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}
