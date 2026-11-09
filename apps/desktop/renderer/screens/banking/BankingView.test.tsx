// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BankingScreen } from "./BankingScreen.js";
import { syntheticBankingPort } from "./BankingView.stories.js";
import type { BankingReply } from "./useBankingScreen.js";

afterEach(() => vi.unstubAllGlobals());

it("runs the native banking consent and recovers an unknown import by checking the attempt", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = syntheticBankingPort(true);
  let opened = "";
  const bridged = {
    ...port,
    openBank: async (url: string) => {
      opened = url;
    },
  };
  const click = async (needle: string) => {
    const target = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(needle),
    );
    expect(target, needle).toBeDefined();
    await act(async () => {
      target?.click();
    });
  };
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="synthetic-a" port={bridged} language="en" />),
    );
    expect(container.textContent).toContain("Synthetic Bank");
    const field = container.querySelector('input[list="banking-institutions"]') as HTMLInputElement;
    await act(async () => {
      field.value = "Synthetic Bank";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = field.closest("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await click("Open bank page");
    expect(opened).toBe("https://synthetic-bank.example/authorize");
    await click("Sync now");
    expect(container.textContent).toContain("Import outcome is unknown");
    await click("Check attempt");
    expect(container.textContent).toContain("Import completed");
    expect(container.textContent).not.toContain("b".repeat(32));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("configures through the native chooser, completes a manual callback, and forgets locally", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = syntheticBankingPort();
  const submit = async (field: HTMLInputElement) => {
    await act(async () => {
      field
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />),
    );
    const appId = container.querySelector('input[maxlength="128"]') as HTMLInputElement;
    await submit(appId);
    expect(container.textContent).toContain("Connect bank");
    const bank = container.querySelector('input[list="banking-institutions"]') as HTMLInputElement;
    await submit(bank);
    const callback = container.querySelector('input[type="url"]') as HTMLInputElement;
    expect(callback).toBeTruthy();
    await submit(callback);
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(container.textContent).toContain("Synthetic Bank");
    const forget = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Forget saved connection"),
    );
    await act(async () => {
      forget?.click();
    });
    expect(container.textContent).not.toContain("Synthetic Bank");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("resumes or cancels a pending consent and keeps unknown attempts after Settings remount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = syntheticBankingPort(true);
  const render = async () =>
    act(async () => root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />));
  const submitBank = async () => {
    const bank = container.querySelector('input[list="banking-institutions"]') as HTMLInputElement;
    await act(async () => {
      bank.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  try {
    await render();
    await submitBank();
    await act(async () => root.render(<div />));
    await render();
    expect(container.textContent).toContain("Open bank page");
    const cancel = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Cancel connection",
    );
    await act(async () => {
      cancel?.click();
    });
    expect(container.textContent).not.toContain("Open bank page");
    const sync = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Sync now",
    );
    await act(async () => {
      sync?.click();
    });
    await act(async () => root.render(<div />));
    await render();
    expect(container.textContent).toContain("Check attempt");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("drops a delayed status from the previous vault and resets its forms", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let release: ((value: BankingReply) => void) | undefined;
  const first = syntheticBankingPort();
  const oldPort = {
    ...first,
    invoke: (action: Parameters<typeof first.invoke>[0]) =>
      action.type === "status"
        ? new Promise<Awaited<ReturnType<typeof first.invoke>>>((resolve) => {
            release = resolve;
          })
        : first.invoke(action),
  };
  const second = syntheticBankingPort(true);
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="profile-a" port={oldPort} language="en" />),
    );
    await act(async () =>
      root.render(<BankingScreen vaultId="profile-b" port={second} language="en" />),
    );
    expect(container.textContent).toContain("Synthetic Bank");
    await act(async () => {
      release?.({
        ok: true,
        value: { configured: false, sessions: [], pendingConsent: "https://old.example/authorize" },
      });
    });
    expect(container.textContent).toContain("Synthetic Bank");
    expect(container.textContent).not.toContain("Open bank page");
    expect(container.querySelector('input[maxlength="128"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["reply", "transport"] as const)(
  "shows an unknown sync outcome after %s uncertainty",
  async (failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const base = syntheticBankingPort(true);
    const port = {
      ...base,
      invoke: (action: Parameters<typeof base.invoke>[0]) =>
        action.type === "sync"
          ? failure === "reply"
            ? Promise.resolve({ ok: false as const, error: "outcome_unknown" })
            : Promise.reject(new Error("connection_lost"))
          : base.invoke(action),
    };
    try {
      await act(async () =>
        root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />),
      );
      const sync = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === "Sync now",
      );
      await act(async () => {
        sync?.click();
      });
      expect(container.textContent).toContain("Import outcome is unknown");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("configures from a dropped key file and explains a wrong file or a missing application ID", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const base = syntheticBankingPort();
  const dropped: { appId: string; name: string }[] = [];
  let refuse: string | null = "app_id_required";
  const port = {
    ...base,
    async configureWithDroppedKey(appId: string, file: File): Promise<BankingReply> {
      dropped.push({ appId, name: file.name });
      if (refuse) return { ok: false, error: refuse };
      return base.configureWithDroppedKey(appId, file);
    },
  };
  const drop = async (file: File) => {
    const zone = container.querySelector('[data-testid="banking-key-drop"]') as HTMLElement;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file], dropEffect: "" } });
    await act(async () => {
      zone.dispatchEvent(event);
    });
  };
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />),
    );
    expect(container.textContent).toContain("in brackets next to the application name");
    await drop(new File(["synthetic"], "notes.txt"));
    expect(dropped).toEqual([]);
    expect(container.textContent).toContain("This is not a .pem key file");
    await drop(new File(["synthetic"], "my key.pem"));
    expect(dropped).toEqual([{ appId: "", name: "my key.pem" }]);
    expect(container.textContent).toContain("Enter the application ID");
    refuse = "key_invalid";
    await drop(new File(["synthetic"], "2e79b1c2-0000-4000-8000-000000000000.pem"));
    expect(container.textContent).toContain("is not an RSA private key");
    refuse = null;
    await drop(new File(["synthetic"], "2e79b1c2-0000-4000-8000-000000000000.pem"));
    expect(container.textContent).toContain("Connect bank");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
