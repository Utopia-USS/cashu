import { expect, it } from "vitest";
import { alertDraft, alertInput } from "./alertForm.js";
import { signalsStorySnapshot } from "./storyState.js";

it("normalizes a new alert tag and clears an edited tag without changing unrelated fields", () => {
  const data = signalsStorySnapshot();
  const row = data.alerts[0];
  if (!row) throw new Error("Synthetic alert missing");
  const existing = { ...row, params: { level: 145 }, tag: "cena" };
  const draft = alertDraft(existing, data.catalog);
  expect(draft.tag).toBe("cena");

  const cleared = alertInput({ ...draft, tag: " " }, existing, data.catalog, data.instruments);
  expect(cleared).toMatchObject({ ok: true, fields: { tag: null } });

  const changed = alertInput(
    { ...draft, tag: "  ŻÓŁĆ   Test  " },
    existing,
    data.catalog,
    data.instruments,
  );
  expect(changed).toMatchObject({ ok: true, fields: { tag: "żółć test" } });

  const invalid = alertInput(
    { ...draft, tag: "invalid/tag" },
    existing,
    data.catalog,
    data.instruments,
  );
  expect(invalid).toMatchObject({ ok: false, reason: "alert_invalid" });
});
