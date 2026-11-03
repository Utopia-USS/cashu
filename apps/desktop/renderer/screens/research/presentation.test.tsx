import { formatCalendarDate } from "@cashu/i18n/values";
import { UiEnvProvider } from "@cashu/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { researchNoteDates, researchNoteFacts } from "./presentation.js";
import { type ResearchNote, ResearchNoteView } from "./ResearchNoteView.js";

const priorZone = process.env.TZ;
afterEach(() => {
  if (priorZone === undefined) delete process.env.TZ;
  else process.env.TZ = priorZone;
});

it("renders a source timestamp near local midnight as its visible calendar date", () => {
  process.env.TZ = "Europe/Warsaw";
  const note = {
    id: "a".repeat(32),
    kind: "news",
    title: "Synthetic timestamp note",
    summary: "Synthetic source content.",
    observed_at: "2026-10-05T23:30:00Z",
    expires_at: "2026-10-07T23:30:00Z",
    created_by: "agent",
    sources: [],
    details: null,
    candidate: null,
    instrument_id: null,
    segment: null,
    unread: false,
    expired: false,
    dismissed: false,
  } as unknown as ResearchNote;
  const markup = renderToStaticMarkup(
    <UiEnvProvider locale="en-US" privacy={false}>
      <ResearchNoteView
        note={note}
        dates={researchNoteDates(note)}
        facts={researchNoteFacts(note)}
        privacy={false}
        onClose={() => {}}
      />
    </UiEnvProvider>,
  );
  expect(markup).toContain(formatCalendarDate("2026-10-06", "en-US"));
  expect(markup).not.toContain("2026-10-05T23:30:00Z");
});
