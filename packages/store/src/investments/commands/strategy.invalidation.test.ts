// Touched-table invalidation for the S22b strategy and review commands (testing.md): each batch
// touches a table the matching query reads, a subscriber to that read set is notified once and the
// answer changes. Synthetic data only.
import { describe, it } from "vitest";
import { reviews } from "../queries/reviews.js";
import { latestStrategyVersion, strategyVersions } from "../queries/strategy.js";
import { markReviewDone, undoReview } from "./reviews.js";
import { saveStrategyVersion } from "./strategy.js";
import { vault } from "./testing/fixtures.js";
import { expectInvalidates } from "./testing/invalidation.js";

describe("S22b strategy and review batches invalidate the queries that read their tables", () => {
  it("saveStrategyVersion", () => {
    const v = vault();
    expectInvalidates(v, saveStrategyVersion, { yamlText: "version: 1\n" }, latestStrategyVersion);
    v.env.advance(1000);
    expectInvalidates(
      v,
      saveStrategyVersion,
      { yamlText: "version: 1\n", mdText: "Cel." },
      strategyVersions,
    );
  });

  it("markReviewDone and undoReview", () => {
    const v = vault();
    const out = expectInvalidates(v, markReviewDone, { module: "investments" }, (r) => reviews(r));
    if (!out.ok) throw new Error(out.reason);
    expectInvalidates(v, undoReview, { review: out.value.review }, (r) => reviews(r));
  });
});
