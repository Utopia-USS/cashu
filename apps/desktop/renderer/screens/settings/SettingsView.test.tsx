// @vitest-environment jsdom

import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApprovalRequired,
  ConnectorRemovalFixture,
  ConnectorsReady,
  UnboundProviders,
  WindowsManualUpdates,
  WindowsReleasesFixture,
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
    const press = async (label: string) => {
      const target = [...document.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      await act(async () => target?.click());
    };
    await press("Details");
    await press("+ Bind an account");
    const enabled = [...document.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("Enabled"),
    );
    expect(enabled?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("page-2");
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
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === label);
    await act(async () => button("Details")?.click());
    const remove = button("Delete");
    expect(remove).toBeDefined();
    await act(async () => {
      remove?.click();
    });
    expect(document.body.textContent).toContain("all profiles");
    expect(confirm).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    await act(async () => {
      button("Yes, delete")?.click();
    });
    expect(onAction).toHaveBeenCalledWith({ op: "remove", id: "synthetic-fetch", allVaults: true });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("points a Windows install to the releases page in both languages", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    setLanguageForTests("en");
    await act(async () => root.render(<WindowsManualUpdates.render />));
    expect(container.textContent).toContain(
      "on Windows you install new versions yourself from the releases page",
    );
    expect(container.textContent).toContain("1.0.0");
    // No daily check or "Check" button: there is no in-app updater to drive.
    expect(container.textContent).not.toContain("Check daily");
    await act(async () => root.unmount());
    setLanguageForTests("pl");
    const polish = createRoot(container);
    await act(async () => polish.render(<WindowsManualUpdates.render />));
    expect(container.textContent).toContain("na Windows nowe wersje instalujesz ręcznie");
    expect(container.textContent).toContain("Strona wydań");
    await act(async () => polish.unmount());
  } finally {
    container.remove();
  }
});

it("opens the releases page through the screen's handler", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened = vi.fn();
  try {
    await act(async () => root.render(<WindowsReleasesFixture onOpened={opened} />));
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Releases page",
    );
    expect(button?.title).toBe(
      "Opens the cashU releases page with the latest installer in your browser",
    );
    await act(async () => button?.click());
    expect(opened).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shows no manual-update row outside Windows", async () => {
  setLanguageForTests("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<UnboundProviders.render />));
    expect(container.textContent).not.toContain("Releases page");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
