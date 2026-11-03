import { expect, it } from "vitest";
import { saveSignalGroup } from "./groupActions.js";

it("keeps actual saved IDs but never starts a later owner write after its initiating scope changes", async () => {
  let current = true,
    calls = 0;
  let release: (value: { kind: "completed"; value: { decision: string } }) => void = () => {};
  const first = new Promise<{ kind: "completed"; value: { decision: string } }>((resolve) => {
    release = resolve;
  });
  const result = saveSignalGroup(
    [
      () => {
        calls++;
        return first;
      },
      async () => {
        calls++;
        return { kind: "completed", value: { decision: "second" } };
      },
    ],
    () => current,
  );
  current = false;
  release({ kind: "completed", value: { decision: "first" } });
  expect(await result).toEqual({
    status: "partial",
    decisions: ["first"],
    reason: "scope_changed",
  });
  expect(calls).toBe(1);
});
it("represents a genuine fresh-read skip without manufacturing a decision ID", async () => {
  expect(
    await saveSignalGroup([
      async () => ({ kind: "completed", value: { decision: null } }),
      async () => ({ kind: "completed", value: { decision: "actual" } }),
    ]),
  ).toEqual({ status: "saved", decisions: ["actual"] });
});
it("reports a no-op when every freshly checked member is already closed or decided", async () => {
  expect(
    await saveSignalGroup([
      async () => ({ kind: "completed", value: { decision: null } }),
      async () => ({ kind: "completed", value: { decision: null } }),
    ]),
  ).toEqual({ status: "skipped", decisions: [] });
  expect(await saveSignalGroup([])).toEqual({ status: "skipped", decisions: [] });
});

it("stops a group after an uncertain write without calling the next member", async () => {
  let calls = 0;
  const result = await saveSignalGroup([
    async () => {
      calls++;
      return { kind: "outcome_unknown" as const };
    },
    async () => {
      calls++;
      return { kind: "completed" as const, value: { decision: "later" } };
    },
  ]);
  expect(result).toEqual({ status: "unknown", decisions: [] });
  expect(calls).toBe(1);
});
