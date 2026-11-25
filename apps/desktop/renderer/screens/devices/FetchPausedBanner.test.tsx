// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FetchPausedBanner } from "./FetchPausedBanner.js";
import type { KeepFetchingState } from "./useKeepFetching.js";

// Designer copy (DV4 items 1 and 2 and the follow-up's third sentence), quoted verbatim: the oracle is the brief, not the catalog.
const SYNC_OFF = {
  en: "Bank fetch paused: sync is off, so this Mac can't tell whether your other Mac fetches too. Turn sync on, or keep fetching on this Mac.",
  pl: "Pobieranie z banku wstrzymane: synchronizacja jest wyłączona, więc ten Mac nie wie, czy Twój drugi Mac też pobiera. Włącz synchronizację albo pobieraj dalej na tym Macu.",
};
const TAIL = {
  en: "If it is still running, both Macs may fetch once; duplicate transactions are filtered out. cashU asks again in 7 days.",
  pl: "Jeśli wciąż działa, oba Maki mogą raz pobrać dane; zdublowane transakcje zostaną odfiltrowane. cashU zapyta ponownie za 7 dni.",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLanguageForTests("en");
});

const keepFetching = (otherMac: string | null): NonNullable<KeepFetchingState> => ({
  otherMac,
  confirming: true,
  busy: false,
  failed: false,
  onAsk: () => {},
  onCancel: () => {},
  onConfirm: () => {},
});

async function show(
  language: "en" | "pl",
  fetchPaused: "outage" | "sync_off",
  state: KeepFetchingState,
) {
  setLanguageForTests(language);
  await act(async () =>
    root.render(
      <FetchPausedBanner fetchPaused={fetchPaused} keepFetching={state} secondary={null} />,
    ),
  );
}
const bannerText = () => container.querySelector('[role="alert"] > p')?.textContent;
/** Dialog F renders in a portal. */
const dialogBody = () => document.body.querySelector('[role="dialog"] p')?.textContent;

it.each(["en", "pl"] as const)(
  "sync off: the banner says to turn sync on or keep fetching (%s)",
  async (language) => {
    await show(language, "sync_off", null);
    expect(bannerText()).toBe(SYNC_OFF[language]);
  },
);

it("the 7-day banner still says 'your other Mac' without a name", async () => {
  await show("en", "outage", keepFetching("Mac mini"));
  expect(bannerText()).toContain("your other Mac for 7 days");
  expect(bannerText()).not.toContain("Mac mini");
});

it.each([
  ["en", "Mac mini", `Mac mini hasn't reported for 7 days. ${TAIL.en}`],
  ["pl", "Mac mini", `Mac mini nie odzywa się od 7 dni. ${TAIL.pl}`],
  ["en", null, `Your other Mac hasn't reported for 7 days. ${TAIL.en}`],
  ["pl", null, `Twój drugi Mac nie odzywa się od 7 dni. ${TAIL.pl}`],
] as const)("keep-fetching dialog body (%s, name %s)", async (language, name, body) => {
  await show(language, "outage", keepFetching(name));
  expect(dialogBody()).toBe(body);
  // The name stands alone.
  expect(dialogBody()).not.toMatch(/other Mac Mac|drugi Mac Mac/);
});
