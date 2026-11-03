// @vitest-environment jsdom

import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalRequired, Ready, UnboundProviders } from "./SettingsView.stories.js";

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

it("offers a pending approval cancellation without showing enabled", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApprovalRequired.render />));
    expect(container.textContent).toContain("Requires approval in System Settings");
    const cancel = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Cancel pending approval"),
    );
    expect(cancel?.disabled).toBe(false);
    const label = [...container.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("Enable daily start"),
    );
    expect(label?.querySelector("input")?.checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
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
      expect(container.textContent).toContain(
        language === "pl" ? "Włącz codzienne uruchamianie" : "Enable daily start",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("disables registration when no OS service provider is bound", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<UnboundProviders.render />));
    const label = [...container.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("Enable daily start"),
    );
    const toggle = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(container.textContent).toContain("Unavailable in this environment");
    expect(toggle?.checked).toBe(false);
    expect(toggle?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
