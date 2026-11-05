// @vitest-environment jsdom

import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApprovalRequired,
  ConnectorRemovalFixture,
  ConnectorsReady,
  Ready,
  UnboundProviders,
} from "./SettingsView.stories.js";

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
    const toggle = container.querySelector('[role="switch"][aria-label="Enable daily start"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
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
    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Enable daily start"]',
    );
    expect(container.textContent).toContain("Unavailable in this environment");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows a populated connector with a boolean control and no raw cursor", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ConnectorsReady.render />));
    expect(container.textContent).toContain("Synthetic fetch");
    const enabled = [...container.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("Enabled"),
    );
    expect(enabled?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.textContent).not.toContain("page-2");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("requires explicit all-profile confirmation before removing a connector", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAction = vi.fn(async () => undefined);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await act(async () => root.render(<ConnectorRemovalFixture onAction={onAction} />));
    const remove = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Remove connector from all profiles",
    );
    expect(remove).toBeDefined();
    await act(async () => {
      remove?.click();
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("all profiles"));
    expect(onAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => {
      remove?.click();
    });
    expect(onAction).toHaveBeenCalledWith({ op: "remove", id: "synthetic-fetch", allVaults: true });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
