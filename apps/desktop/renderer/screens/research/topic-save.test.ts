import { expect, it } from "vitest";
import { S } from "./Research.strings.js";
import { saveTopicSequence } from "./topic-save.js";

const value = {
  thesis: "Synthetic owner thesis",
  invalidation: "Synthetic invalidation",
  assessment: "Current assessment",
  outlook: "Current outlook",
  clearSources: false,
  confirmDraft: true,
};

it("stops the second topic write and feedback when privacy or vault scope changes during the first", async () => {
  let resolveFirst: (value: { kind: "completed"; value: null }) => void = () => {};
  const first = new Promise<{ kind: "completed"; value: null }>((resolve) => {
    resolveFirst = resolve;
  });
  let current = true;
  const calls: string[] = [];
  const pending = saveTopicSequence({
    topic: "technology",
    record: null,
    value,
    current: () => current,
    saveThesis: () => {
      calls.push("thesis");
      return first;
    },
    deleteThesis: async () => {
      calls.push("delete");
      return { kind: "completed" as const, value: null };
    },
    setView: async () => {
      calls.push("view");
      return { kind: "completed" as const, value: null };
    },
    notice: () => calls.push("notice"),
    saved: () => calls.push("saved"),
  });
  current = false;
  resolveFirst({ kind: "completed" as const, value: null });
  await pending;
  expect(calls).toEqual(["thesis"]);
});

it("reports a truthful partial save when the view write refuses after the thesis commits", async () => {
  const notices: string[] = [];
  let saved = false;
  await saveTopicSequence({
    topic: "technology",
    record: null,
    value,
    current: () => true,
    saveThesis: async () => ({ kind: "completed" as const, value: null }),
    deleteThesis: async () => ({ kind: "completed" as const, value: null }),
    setView: async () => ({ kind: "refused" as const, reason: "invalid_view" }),
    notice: (message) => notices.push(message),
    saved: () => {
      saved = true;
    },
  });
  expect(notices).toEqual([S.partialSave]);
  expect(saved).toBe(false);
});

it("keeps stored sources on an ordinary view edit and clears only on explicit request", async () => {
  const record = {
    thesis: value.thesis,
    invalidation: value.invalidation,
    assessment: "Prior",
    outlook: value.outlook,
  } as unknown as Parameters<typeof saveTopicSequence>[0]["record"];
  const sent: { sources?: readonly unknown[] }[] = [];
  const base = {
    topic: "technology",
    record,
    current: () => true,
    saveThesis: async () => ({ kind: "completed" as const, value: null }),
    deleteThesis: async () => ({ kind: "completed" as const, value: null }),
    setView: async (input: { sources?: readonly unknown[] }) => {
      sent.push(input);
      return { kind: "completed" as const, value: null };
    },
    notice: () => {},
    saved: () => {},
  };
  await saveTopicSequence({ ...base, value });
  await saveTopicSequence({ ...base, value: { ...value, clearSources: true } });
  expect(sent[0]).not.toHaveProperty("sources");
  expect(sent[1]?.sources).toEqual([]);
});

it("lets an owner edit only the market view while an agent draft stays pending", async () => {
  const calls: string[] = [];
  await saveTopicSequence({
    topic: "technology",
    record: {
      draft: true,
      thesis: value.thesis,
      invalidation: value.invalidation,
      assessment: "Earlier assessment",
      outlook: value.outlook,
    } as unknown as Parameters<typeof saveTopicSequence>[0]["record"],
    value: { ...value, confirmDraft: false },
    current: () => true,
    saveThesis: async () => {
      calls.push("thesis");
      return { kind: "completed" as const, value: null };
    },
    deleteThesis: async () => {
      calls.push("delete");
      return { kind: "completed" as const, value: null };
    },
    setView: async () => {
      calls.push("view");
      return { kind: "completed" as const, value: null };
    },
    notice: () => {},
    saved: () => {},
  });
  expect(calls).toEqual(["view"]);
});

it("writes the owner thesis when explicitly confirming an unchanged agent draft", async () => {
  const calls: string[] = [];
  await saveTopicSequence({
    topic: "technology",
    record: {
      draft: true,
      thesis: value.thesis,
      invalidation: value.invalidation,
      assessment: value.assessment,
      outlook: value.outlook,
    } as unknown as Parameters<typeof saveTopicSequence>[0]["record"],
    value,
    current: () => true,
    saveThesis: async () => {
      calls.push("thesis");
      return { kind: "completed" as const, value: null };
    },
    deleteThesis: async () => {
      calls.push("delete");
      return { kind: "completed" as const, value: null };
    },
    setView: async () => {
      calls.push("view");
      return { kind: "completed" as const, value: null };
    },
    notice: () => {},
    saved: () => {},
  });
  expect(calls).toEqual(["thesis"]);
});
