import { setLanguageForTests } from "@cashu/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { noticeLabel, polarityGlyph, refusalLabel, statusLabel } from "./labels.js";
import type { SignalsNotice } from "./outcomes.js";

afterEach(() => setLanguageForTests("en"));

describe("noticeLabel", () => {
  it("says Removed and Restored after deleting or restoring a watch or alert, not Saved", () => {
    setLanguageForTests("en");
    expect(noticeLabel("removed")).toBe("Removed");
    expect(noticeLabel("restored")).toBe("Restored");
    setLanguageForTests("pl");
    expect(noticeLabel("removed")).toBe("Usunięto");
    expect(noticeLabel("restored")).toBe("Przywrócono");
  });

  it("gives every notice other than saved its own copy", () => {
    setLanguageForTests("en");
    const notices: SignalsNotice[] = [
      "skipped",
      "partial",
      "unknown",
      "unavailable",
      "previous_completed",
      "previous_refused",
      "failed",
      "cleanup",
      "cache",
      "watch_warning",
      "removed",
      "restored",
    ];
    const saved = noticeLabel("saved");
    for (const notice of notices) expect(noticeLabel(notice), notice).not.toBe(saved);
  });
});

describe("refusalLabel", () => {
  it("maps known refusals to owner copy without the raw code", () => {
    setLanguageForTests("en");
    expect(refusalLabel("undo_expired")).toBe("It is too late to undo this.");
    expect(refusalLabel("no_alert")).not.toContain("no_alert");
    setLanguageForTests("pl");
    expect(refusalLabel("watchlist_full")).toBe("Lista obserwowanych jest pełna.");
  });

  it("keeps a generic fallback that still names an unknown code for support", () => {
    setLanguageForTests("en");
    expect(refusalLabel("synthetic_refusal")).toBe(
      "The change was not saved (code: synthetic_refusal).",
    );
  });
});

it("labels unknown states by their code and draws polarity glyphs from the catalog", () => {
  setLanguageForTests("en");
  expect(statusLabel("triggered")).toBe("Triggered");
  expect(statusLabel("synthetic")).toBe("Code: synthetic");
  expect(polarityGlyph("positive")).toBe("●");
  expect(polarityGlyph("negative")).toBe("◆");
  expect(polarityGlyph("neutral")).toBe("■");
});
