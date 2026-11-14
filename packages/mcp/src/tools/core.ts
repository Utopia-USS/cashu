// Python-compatible schema metadata and ordering. Handler references are the native implementation.
import { MODULE_IDS } from "@cashu/domain/core";
import { type ToolSpec, toolSpec } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { networthBreakdown } from "./networth.js";
import { profileOverview, setupStatus } from "./profile.js";
import { markReviewDone } from "./review.js";

const REVIEW_CARDS = ["world", "sectors", "positions", "events", "ideas", "calendar", "decide"];
export function coreTools(): readonly ToolSpec<NativeToolStore>[] {
  return [
    toolSpec({
      name: "profile_overview",
      module: "core",
      description:
        "Start here: enabled modules with setup states and their tools, base currency, privacy level (strict = shares only), data freshness, pending proposals, last reviews.",
      handler: profileOverview,
    }),
    toolSpec({
      name: "setup_status",
      module: "core",
      description: "Setup steps of a module (done / on / todo) and the next action.",
      handler: setupStatus,
      properties: { module: { type: "string", enum: MODULE_IDS } },
      required: ["module"],
    }),
    toolSpec({
      name: "networth_breakdown",
      module: "core",
      description:
        "Net worth per currency: bucket shares of assets, asset/liability ratio, 12-month change in %. Absolute amounts only in the 'amounts' privacy mode.",
      handler: networthBreakdown,
    }),
    toolSpec({
      name: "mark_review_done",
      module: "core",
      description:
        "Record that the periodic review of a module (default investments) is done, with notes and (investments) the agenda: the review cards the owner wants followed up, each with a note.",
      handler: markReviewDone,
      properties: {
        notes: { type: "string", maxLength: 4000 },
        agenda: {
          type: "array",
          maxItems: 20,
          description:
            "investments review cards the owner wants followed up in the next research run, each with the owner's note",
          items: {
            type: "object",
            properties: {
              card: { type: "string", enum: REVIEW_CARDS },
              note: { type: "string", maxLength: 500 },
            },
            required: ["card"],
            additionalProperties: false,
          },
        },
        module: { type: "string", enum: MODULE_IDS, default: "investments" },
      },
      write: true,
    }),
  ];
}
