/** Research and rule findings share the same candidate contract, preserving research bytes. */
import { expect, it } from "vitest";
import type { SignalCandidate } from "../rules/index.js";
import { days, utcInstant } from "./instant.js";
import { candidateFor, type ResearchNoteRecord } from "./signals.js";

const NOW = utcInstant("2026-10-05", 6);
const NOTE: ResearchNoteRecord = {
  id: 7,
  kind: "news",
  polarity: "negative",
  strength: 3,
  thesisRelation: "invalidates",
  thesisField: null,
  title: "Synthetic update",
  sources: ["https://example.test/a", "https://example.test/b"],
  details: { headline: "Synthetic headline" },
  instrumentId: "synthetic-instrument",
  segment: null,
  theme: null,
  createdAt: NOW,
  expiresAt: NOW + days(7),
  dismissedAt: null,
};

it("returns the shared rule candidate with unchanged research references, polarity and text", () => {
  const key = "research:2026-W41|i:synthetic-instrument";
  const shared: SignalCandidate | null = candidateFor(key, [NOTE], NOW, "en");
  expect(shared).toMatchObject({
    dedupKey: key,
    severity: "action",
    polarity: "negative",
    instrumentId: NOTE.instrumentId,
    accountId: null,
    message: "Analysis (news, invalidates the thesis): Synthetic update; strength 3/3, 2 sources",
    payload: { note_id: 7, note_ids: [7], notes: 1, headline: "Synthetic headline" },
  });
  expect(() => candidateFor(key, [{ ...NOTE, polarity: "unsupported" }], NOW, "en")).toThrow(
    "not a valid SignalPolarity",
  );
});
