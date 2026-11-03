// @vitest-environment jsdom

import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Ready } from "./SettingsView.stories.js";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["pl", "en"] as const)(
  "renders nonempty audit and worker timestamps in %s",
  async (language) => {
    setLanguageForTests(language);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Ready.render />));
      expect(container.textContent).toContain("synthetic_tool");
      expect(container.textContent).toContain("Synthetic Household");
      expect(container.textContent).toContain("08:30");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
