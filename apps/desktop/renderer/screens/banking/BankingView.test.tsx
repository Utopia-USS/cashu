// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BankingScreen } from "./BankingScreen.js";
import { syntheticBankingPort } from "./BankingView.stories.js";
import type { BankingReply } from "./useBankingScreen.js";

afterEach(() => vi.unstubAllGlobals());

/** Picks an option of the bank picker the way the system picker does (React sees the change). */
async function choose(container: HTMLElement, name: string) {
  const select = container.querySelector("select") as HTMLSelectElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(select, name);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Submits the form that holds `field`. */
async function submitForm(field: Element | null) {
  await act(async () => {
    field?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** The owner pastes the bank's return address into the folded fallback. */
async function pasteCallback(container: HTMLElement, url: string) {
  const field = container.querySelector('input[type="url"]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(field, url);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submitForm(field);
}

it("runs the native banking consent and recovers an unknown import by checking the attempt", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = syntheticBankingPort(true);
  let opened = "";
  let settled = 0;
  let releaseImport: (() => void) | undefined;
  const bridged = {
    ...port,
    // The first import takes a while: hold it until the test lets it finish.
    async invoke(action: Parameters<typeof port.invoke>[0]): Promise<BankingReply> {
      if (action.type === "completeConsent")
        await new Promise<void>((resolve) => {
          releaseImport = resolve;
        });
      return port.invoke(action);
    },
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
    await choose(container, "Synthetic Bank");
    await submitForm(container.querySelector("select"));
    // cashU waits for the bank by itself; the next step is the one primary button.
    expect(container.textContent).toContain("Waiting for your consent on the bank's page");
    await click("Open bank page");
    expect(opened).toBe("https://synthetic-bank.example/authorize");
    await pasteCallback(container, "https://127.0.0.1:18888/eb/callback?code=synthetic&state=s");
    // Between the bank's answer and the end of the import the screen says what is going on.
    expect(container.textContent).toContain("The bank confirmed the consent");
    expect(container.textContent).not.toContain("Open bank page");
    await act(async () => {
      releaseImport?.();
    });
    expect(container.textContent).not.toContain("The bank confirmed the consent");
    expect(container.textContent).toContain("Data refreshed");
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
    await choose(container, "Synthetic Bank");
    await submitForm(container.querySelector("select"));
    expect(container.querySelector('input[type="url"]')).toBeTruthy();
    await pasteCallback(container, "https://127.0.0.1:18888/eb/callback?code=synthetic&state=s");
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
    await choose(container, "Synthetic Bank");
    await submitForm(container.querySelector("select"));
  };
  try {
    await render();
    await submitBank();
    await act(async () => root.render(<div />));
    await render();
    expect(container.textContent).toContain("Open bank page");
    // Nobody waits after a remount until the owner opens the bank again.
    expect(container.textContent).toContain("Open the bank's page and give your consent");
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

it("picks a bank from Enable Banking's list and retries right after a refusal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const base = syntheticBankingPort(true);
  const begun: string[] = [];
  let refusal: string | null = "unknown_bank";
  const port = {
    ...base,
    openBank: async () => {
      throw new Error("synthetic refusal");
    },
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
    // The list loads by itself; nothing is chosen until the owner picks a bank.
    const options = [...container.querySelectorAll("option")];
    expect(options.map((node) => node.textContent)).toEqual([
      "Choose a bank",
      "Bank Millennium",
      "Bank Pekao",
      "mBank",
    ]);
    expect(options[0]?.disabled).toBe(true);
    expect(connect().disabled).toBe(true);
    await submit();
    expect(begun).toEqual([]);
    await choose(container, "Bank Millennium");
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
    // A page the app may not open says so instead of doing nothing.
    const open = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Open bank page"),
    );
    await act(async () => {
      open?.click();
    });
    expect(container.textContent).toContain("The bank's page could not be opened");
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

it("shows the configured application and removes it only after a confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const port = syntheticBankingPort(true);
  const press = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => {
      button?.click();
    });
  };
  try {
    await act(async () =>
      root.render(<BankingScreen vaultId="synthetic-a" port={port} language="en" />),
    );
    expect(container.textContent).toContain("Enable Banking is configured");
    expect(container.textContent).toContain("2e79b1c2-0000-4000-8000-000000000000");
    expect(container.textContent).toContain("Connect another bank");
    // Changing the key brings the key form back, and it can be closed again.
    await press("Change application or key");
    expect(container.querySelector('[data-testid="banking-key-drop"]')).not.toBeNull();
    await press("Keep the current configuration");
    expect(container.querySelector('[data-testid="banking-key-drop"]')).toBeNull();
    await press("Remove configuration");
    expect(container.textContent).toContain("Connected banks stop syncing");
    await press("Keep it");
    expect(container.textContent).toContain("Enable Banking is configured");
    await press("Remove configuration");
    await press("Yes, remove");
    expect(container.textContent).toContain("The Enable Banking configuration was removed");
    expect(container.querySelector('[data-testid="banking-key-drop"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Enable Banking is configured");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
