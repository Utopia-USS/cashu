// @vitest-environment jsdom
// The research reader opens over the review deck: the deck stays mounted (same panel node, so its scroll
// position and focus survive) and opening and closing a note leaves the deck's own history entry current.
import { setLanguageForTests } from "@cashu/i18n";
import { Modal, UiEnvProvider } from "@cashu/ui";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ReviewView } from "./ReviewView.js";
import { useStoryState } from "./storyState.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
beforeEach(() => setLanguageForTests("en"));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** ReviewScreen's composition without a store: the deck plus the reader dialog it opens. */
function Harness() {
  const story = useStoryState("world");
  const [reader, setReader] = useState<string | null>(null);
  // The world card's risk brief opens its note outside the virtualized rows (no layout in jsdom).
  const riskBrief = { note: "synthetic-note", headline: "Synthetic risk", why: "Synthetic reason" };
  const session = story.session && {
    ...story.session,
    snapshot: { ...story.session.snapshot, riskBrief },
  };
  return (
    <>
      <ReviewView state={{ ...story, session, reader, setReader }} />
      {reader && (
        <Modal label="Synthetic note" placement="center" onClose={() => setReader(null)}>
          <button type="button" onClick={() => setReader(null)}>
            Close note
          </button>
        </Modal>
      )}
    </>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const modalId = () => (window.history.state as { cashuModal?: number } | null)?.cashuModal;
const dialog = (label: string) => document.querySelector(`[role="dialog"][aria-label="${label}"]`);

it("keeps the deck mounted under the reader and pops only the reader's history entry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <UiEnvProvider locale="en-US" privacy={false}>
        <Harness />
      </UiEnvProvider>,
    ),
  );
  await settle();
  const deck = dialog("Synthetic review");
  expect(deck).not.toBeNull();
  const deckEntry = modalId();
  expect(deckEntry).toBeTypeOf("number");
  const length = window.history.length;

  const open = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Full note",
  );
  expect(open).toBeDefined();
  // Chromium focuses a clicked button; jsdom does not, so the test focuses it as the click would.
  open?.focus();
  await act(async () => open?.click());
  await settle();
  expect(dialog("Synthetic note")).not.toBeNull();
  expect(dialog("Synthetic review")).toBe(deck);
  expect(deck?.classList.contains("invisible")).toBe(true);
  expect((deck as HTMLElement | null)?.inert).toBe(true);
  expect(modalId()).not.toBe(deckEntry);

  const close = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Close note",
  );
  await act(async () => close?.click());
  await settle();
  expect(dialog("Synthetic note")).toBeNull();
  expect(dialog("Synthetic review")).toBe(deck);
  expect(deck?.classList.contains("invisible")).toBe(false);
  expect((deck as HTMLElement | null)?.inert).toBeFalsy();
  expect(modalId()).toBe(deckEntry);
  expect(window.history.length).toBe(length + 1);
  expect(document.activeElement).toBe(open);
});
