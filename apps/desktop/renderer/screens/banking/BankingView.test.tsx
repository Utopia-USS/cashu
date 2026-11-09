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
  let settled = 0;
  const bridged = {
    ...port,
    openBank: async (url: string) => {
      opened = url;
    },
    settled: () => {
      settled++;
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
    const field = container.querySelector('input[type="search"]') as HTMLInputElement;
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
    expect(container.textContent).toContain("It is not known whether");
    expect(settled).toBe(0);
    await click("Check attempt");
    expect(container.textContent).toContain("Import completed");
    // Every unknown attempt is resolved: the panel may accept writes again.
    expect(settled).toBe(1);
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
    const bank = container.querySelector('input[type="search"]') as HTMLInputElement;
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
    expect(container.textContent).not.toContain("Forget saved connection");
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
    const bank = container.querySelector('input[type="search"]') as HTMLInputElement;
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
      expect(container.textContent).toContain("It is not known whether");
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

it("picks a bank from Enable Banking's list, never sends free text, and retries after a refusal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const base = syntheticBankingPort(true);
  const begun: string[] = [];
  let refusal: string | null = "unknown_bank";
  const port = {
    ...base,
    async invoke(action: Parameters<typeof base.invoke>[0]): Promise<BankingReply> {
      if (action.type === "banks")
        return {
          ok: true,
          value: [{ name: "mBank" }, { name: "Bank Millennium" }, { name: "Bank Pekao" }],
        };
      if (action.type === "check")
        return { ok: true, value: { ok: true, application: { name: "cashu" } } };
      if (action.type === "beginConsent") {
        begun.push(action.aspsp);
        if (refusal) return { ok: false, error: refusal };
      }
      return base.invoke(action);
    },
  };
  const type = async (value: string) => {
    const field = container.querySelector('input[type="search"]') as HTMLInputElement;
    // React tracks the last value it rendered; the native setter makes the change visible to it.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const connect = () =>
    [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Connect bank"),
    ) as HTMLButtonElement;
  const submit = async () => {
    await act(async () => {
      connect()
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />),
    );
    // The list loads by itself; with three banks nothing is chosen yet.
    expect(container.querySelectorAll("option")).toHaveLength(3);
    expect(connect().disabled).toBe(true);
    await type("xyz");
    expect(container.textContent).toContain("No bank on Enable Banking's list matches");
    expect(connect().disabled).toBe(true);
    await submit();
    expect(begun).toEqual([]);
    // Misspelt, without the bank's prefix: still the one listed name.
    await type("millenium");
    expect([...container.querySelectorAll("option")].map((node) => node.textContent)).toEqual([
      "Bank Millennium",
    ]);
    expect(connect().disabled).toBe(false);
    await submit();
    expect(begun).toEqual(["Bank Millennium"]);
    expect(container.textContent).toContain("Enable Banking does not know a bank of that name");
    // A definite refusal leaves the screen ready: the same button works again at once.
    refusal = "redirect_not_allowed";
    await submit();
    expect(container.textContent).toContain("add https://127.0.0.1:18888/eb/callback");
    refusal = null;
    await submit();
    expect(begun).toEqual(["Bank Millennium", "Bank Millennium", "Bank Millennium"]);
    expect(container.textContent).toContain("Open bank page");
    const check = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Check application"),
    );
    await act(async () => {
      check?.click();
    });
    expect(container.textContent).toContain(
      "The Enable Banking connection works. Application: cashu",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
