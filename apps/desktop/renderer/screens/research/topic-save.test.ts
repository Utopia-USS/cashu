import { expect, it } from "vitest";
import { S } from "./Research.strings.js";
import { saveTopicSequence } from "./topic-save.js";

type Input = Parameters<typeof saveTopicSequence>[0];
type Record = Input["record"];

const value = {
  thesis: "Synthetic owner thesis",
  invalidation: "Synthetic invalidation",
  assessment: "Current assessment",
  outlook: "Current outlook",
  clearSources: false,
  confirmDraft: true,
};
const done = { kind: "completed" as const, value: null };

/** Runs one save recording host writes and feedback; `overrides` replaces any part of the input. */
async function save(overrides: Partial<Input> = {}) {
  const calls: string[] = [];
  const feedback: string[] = [];
  const views: { sources?: readonly unknown[] }[] = [];
  await saveTopicSequence({
    topic: "technology",
    record: null,
    value,
    current: () => true,
    saveThesis: async () => {
      calls.push("thesis");
      return done;
    },
    deleteThesis: async () => {
      calls.push("delete");
      return done;
    },
    setView: async (input: { sources?: readonly unknown[] }) => {
      calls.push("view");
      views.push(input);
      return done;
    },
    notice: () => feedback.push("notice"),
    saved: () => feedback.push("saved"),
    ...overrides,
  });
  return { calls, feedback, views };
}

it("stops the second topic write and feedback when privacy or vault scope changes during the first", async () => {
  let current = true;
  const first: string[] = [];
  const { calls, feedback } = await save({
    current: () => current,
    saveThesis: async () => {
      first.push("thesis");
      // The scope changes while the first write is in flight.
      current = false;
      return done;
    },
  });
  expect(first).toEqual(["thesis"]);
  expect(calls).toEqual([]);
  expect(feedback).toEqual([]);
});

it("reports a truthful partial save when the view write refuses after the thesis commits", async () => {
  const notices: string[] = [];
  const { feedback } = await save({
    setView: async () => ({ kind: "refused" as const, reason: "invalid_view" }),
    notice: (message) => notices.push(message),
  });
  expect(notices).toEqual([S.partialSave]);
  expect(feedback).not.toContain("saved");
});

it("keeps stored sources on an ordinary view edit and clears only on explicit request", async () => {
  const record = {
    thesis: value.thesis,
    invalidation: value.invalidation,
    assessment: "Prior",
    outlook: value.outlook,
  } as unknown as Record;
  const ordinary = await save({ record });
  const cleared = await save({ record, value: { ...value, clearSources: true } });
  expect(ordinary.views[0]).not.toHaveProperty("sources");
  expect(cleared.views[0]?.sources).toEqual([]);
});

it("lets an owner edit only the market view while an agent draft stays pending", async () => {
  const { calls } = await save({
    record: {
      draft: true,
      thesis: value.thesis,
      invalidation: value.invalidation,
      assessment: "Earlier assessment",
      outlook: value.outlook,
    } as unknown as Record,
    value: { ...value, confirmDraft: false },
  });
  expect(calls).toEqual(["view"]);
});

it("writes the owner thesis when explicitly confirming an unchanged agent draft", async () => {
  const { calls } = await save({
    record: {
      draft: true,
      thesis: value.thesis,
      invalidation: value.invalidation,
      assessment: value.assessment,
      outlook: value.outlook,
    } as unknown as Record,
  });
  expect(calls).toEqual(["thesis"]);
});
