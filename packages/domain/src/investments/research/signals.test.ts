/// <reference types="node" />
/**
 * Test-for-test translation of `tests/investments/research/test_rs_signal_message.py`: research
 * signal messages are Polish and English (the plural of sources, the note kind and thesis relation
 * labels of the dashboard, the message shape).
 */
import { describe, expect, it } from "vitest";
import { RESEARCH_NOTE_KINDS } from "./contract.js";
import {
  KIND_LABEL,
  KIND_LABEL_EN,
  RELATION_LABEL,
  RELATION_LABEL_EN,
  researchMessage,
  sourcesPhrase,
} from "./signals.js";

describe("research signal messages (test_rs_signal_message.py)", () => {
  // test_sources_plural (parametrized)
  it.each([
    [0, "0 źródeł"],
    [1, "1 źródło"],
    [2, "2 źródła"],
    [4, "4 źródła"],
    [5, "5 źródeł"],
    [11, "11 źródeł"],
    [12, "12 źródeł"],
    [14, "14 źródeł"],
    [21, "21 źródeł"],
    [22, "22 źródła"],
    [112, "112 źródeł"],
    [124, "124 źródła"],
  ])("sources plural %i", (count, text) => {
    expect(sourcesPhrase(count, "pl")).toBe(text);
  });

  // test_message_shape_with_kind_and_relation_labels
  it("message shape with kind and relation labels", () => {
    expect(researchMessage("news", "invalidates", "Premiera przesunięta", 3, 2, "pl")).toBe(
      "Analiza (wiadomość, podważa tezę): Premiera przesunięta; siła 3/3, 2 źródła",
    );
    expect(researchMessage("earnings", "weakens", "Słabszy kwartał", 2, 1, "pl")).toBe(
      "Analiza (wyniki, osłabia tezę): Słabszy kwartał; siła 2/3, 1 źródło",
    );
    expect(researchMessage("community", "supports", "Forum o bankach", 3, 5, "pl")).toBe(
      "Analiza (społeczność · szum, wzmacnia tezę): Forum o bankach; siła 3/3, 5 źródeł",
    );
  });

  // test_neutral_or_no_relation_and_unknown_kind
  it("neutral or no relation and unknown kind", () => {
    expect(researchMessage("macro", "neutral", "Stopy w górę", 3, 1, "pl")).toBe(
      "Analiza (makro): Stopy w górę; siła 3/3, 1 źródło",
    );
    expect(researchMessage("trend", "none", "Miedź", 3, 3, "pl")).toBe(
      "Analiza (trend): Miedź; siła 3/3, 3 źródła",
    );
    expect(
      researchMessage("trend", null, "Miedź", 3, 3, "pl").startsWith("Analiza (trend): "),
    ).toBe(true);
    expect(
      researchMessage("other", "weakens", "X", 3, 1, "pl").startsWith(
        "Analiza (other, osłabia tezę)",
      ),
    ).toBe(true);
  });

  // test_every_note_kind_has_a_label
  it("every note kind has a label", () => {
    expect(new Set(KIND_LABEL.keys())).toEqual(new Set(RESEARCH_NOTE_KINDS));
  });

  // test_labels_match_the_dashboard
  it("labels match the dashboard", () => {
    // Dashboard catalogs captured from the retired oracle (frontend/src/modules/investments/v2/research/
    // logic.strings.ts, KIND_LABEL and RELATION_LABEL) on 2026-11-04.
    const dashboard = {
      KIND_LABEL: {
        pl: {
          news: "wiadomość",
          earnings: "wyniki",
          community: "społeczność · szum",
          trend: "trend",
          macro: "makro",
          candidate: "kandydat",
        },
        en: {
          news: "news",
          earnings: "earnings",
          community: "community · noise",
          trend: "trend",
          macro: "macro",
          candidate: "candidate",
        },
      },
      RELATION_LABEL: {
        pl: {
          supports: "wzmacnia tezę",
          weakens: "osłabia tezę",
          invalidates: "podważa tezę",
          fulfills: "spełnia tezę",
          neutral: "nie dotyka tezy",
          none: "bez tezy",
        },
        en: {
          supports: "supports the thesis",
          weakens: "weakens the thesis",
          invalidates: "invalidates the thesis",
          fulfills: "fulfills the thesis",
          neutral: "doesn't touch the thesis",
          none: "no thesis",
        },
      },
    } as const;
    const labels = (name: keyof typeof dashboard, lang: "pl" | "en"): Map<string, string> =>
      new Map(Object.entries(dashboard[name][lang]));
    expect(labels("KIND_LABEL", "pl")).toEqual(KIND_LABEL);
    expect(labels("KIND_LABEL", "en")).toEqual(KIND_LABEL_EN);
    for (const [lang, ours] of [
      ["pl", RELATION_LABEL],
      ["en", RELATION_LABEL_EN],
    ] as const) {
      const catalog = labels("RELATION_LABEL", lang);
      expect(new Map([...ours.keys()].map((k) => [k, catalog.get(k)]))).toEqual(ours);
    }
  });

  // test_english_message
  it("english message", () => {
    expect(sourcesPhrase(1, "en")).toBe("1 source");
    expect(sourcesPhrase(2, "en")).toBe("2 sources");
    expect(researchMessage("news", "invalidates", "Guidance cut", 3, 2, "en")).toBe(
      "Analysis (news, invalidates the thesis): Guidance cut; strength 3/3, 2 sources",
    );
  });
});
