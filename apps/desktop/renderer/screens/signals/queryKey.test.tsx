// @vitest-environment jsdom
// The per-minute display clock stays out of the Signals query key: a surface mounted a minute (or hours)
// later on the same day asks for the same read, so switching pages never reloads the snapshot.
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const asked: unknown[] = [];
vi.mock("@cashu/store-react", () => ({
  isStale: () => false,
  useConnection: () => ({ status: "connected" }),
  useQuery: (_query: unknown, args: unknown) => {
    asked.push(args);
    return { status: "unavailable", reason: "module_disabled" };
  },
  useCommand: () => ({ run: async () => ({}), reconcile: async () => ({}), isPending: false }),
  useUiAction: () => ({ run: async () => ({}), isPending: false }),
}));

const { useSignalsScreen } = await import("./useSignalsScreen.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
beforeEach(() => {
  setLanguageForTests("en");
  vi.useFakeTimers({ toFake: ["Date"] });
  asked.length = 0;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Renders the display clock so the test reads it from the DOM. */
function Surface() {
  return <output>{useSignalsScreen().displayNow}</output>;
}
async function mountAt(instant: string) {
  vi.setSystemTime(new Date(instant));
  await act(async () => root?.unmount());
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<Surface />));
  return { args: asked.at(-1), displayNow: container.textContent };
}

it("asks for the same Signals read when a page mounts minutes later the same day", async () => {
  const first = await mountAt("2026-11-04T10:15:20");
  const later = await mountAt("2026-11-04T10:17:05");
  const evening = await mountAt("2026-11-04T19:59:00");
  expect(first.args).toEqual(later.args);
  expect(first.args).toEqual(evening.args);
  expect(first.displayNow).not.toBe(later.displayNow);
  expect((first.args as { now: string }).now).toBe(new Date("2026-11-04T00:00:00").toISOString());
});

it("moves the read to the next day with the calendar", async () => {
  const today = await mountAt("2026-11-04T23:59:00");
  const tomorrow = await mountAt("2026-11-05T00:01:00");
  expect((tomorrow.args as { now: string }).now).not.toBe((today.args as { now: string }).now);
  expect((tomorrow.args as { today: string }).today).toBe("2026-11-05");
});
