/** Recompute P2/P3 at the caller's exact clock, including saved detail freshness. */
import type { UiLang } from "@cashu/domain/core";
import * as plan from "@cashu/domain/investments/plan";
import type { Read } from "../queries/shared.js";
import { type ReadFactsRequest, readFacts } from "./facts.js";

export function readAnnotations(read: Read, request: ReadFactsRequest & { readonly lang: UiLang }) {
  const facts = readFacts(read, request);
  return { facts, annotations: plan.annotateSubjects(facts.subjects, request.clock, request.lang) };
}
