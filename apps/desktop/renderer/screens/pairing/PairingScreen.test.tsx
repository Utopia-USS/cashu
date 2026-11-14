// @vitest-environment jsdom
import { setLanguageForTests } from "@cashu/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PairingView } from "./PairingView.js";
import { usePairingScreen } from "./usePairingScreen.js";

const bindings = vi.hoisted(() => ({
  vault: "a".repeat(32),
  connection: "online",
  bridge: null as unknown,
  // The live device list snapshot: a new object stands for a host push.
  pushed: { status: "ready" } as object,
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => bindings.connection,
  useQuery: () => bindings.pushed,
}));
vi.mock("./pairingBridge.js", () => ({ pairingBridge: () => bindings.bridge }));

function Harness() {
  return <PairingView state={usePairingScreen()} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLanguageForTests("en");
  bindings.vault = "a".repeat(32);
  bindings.connection = "online";
});
afterEach(() => {
  vi.unstubAllGlobals();
  bindings.bridge = null;
});

it("requires typed six digits and inspects the same unknown invite", async () => {
  const confirm = vi.fn(async () => ({
    kind: "outcome_unknown" as const,
    operationId: "0".repeat(26),
  }));
  const inspect = vi.fn(async () => ({ kind: "completed" as const, operationId: "0".repeat(26) }));
  bindings.bridge = {
    invite: vi.fn(async () => ({
      kind: "ready" as const,
      operationId: "0".repeat(26),
      qr: "synthetic-invite",
      expiresAt: Date.now() + 60_000,
    })),
    confirm,
    inspect,
    cancel: vi.fn(async () => ({ kind: "cancelled" as const })),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => button("Create invitation")?.click());
    expect(button("Confirm code")?.disabled).toBe(true);
    const input = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "123456",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Confirm code")?.disabled).toBe(false);
    await act(async () => button("Confirm code")?.click());
    expect(confirm).toHaveBeenCalledWith({
      vault: bindings.vault,
      operationId: "0".repeat(26),
      code: "123456",
    });
    expect(container.textContent).toContain("The outcome is unknown");
    await act(async () => button("Check outcome")?.click());
    expect(inspect).toHaveBeenCalledWith({ vault: bindings.vault, operationId: "0".repeat(26) });
    expect(container.textContent).toContain("Phone paired.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("ignores a late invitation after a vault switch and cancels that exact operation", async () => {
  const pending = deferred<{ kind: "ready"; operationId: string; qr: string; expiresAt: number }>();
  const cancel = vi.fn(async () => ({ kind: "cancelled" as const }));
  bindings.bridge = {
    invite: vi.fn(() => pending.promise),
    cancel,
    confirm: vi.fn(),
    inspect: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Create invitation")
        ?.click(),
    );
    bindings.vault = "b".repeat(32);
    await act(async () => root.render(<Harness />));
    await act(async () =>
      pending.resolve({
        kind: "ready",
        operationId: "1".repeat(26),
        qr: "stale-invite",
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(container.textContent).not.toContain("stale-invite");
    expect(cancel).toHaveBeenCalledWith({ vault: "a".repeat(32), operationId: "1".repeat(26) });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** Renders the harness, presses "Create invitation" and hands back the container. */
async function created(bridge: unknown) {
  bindings.bridge = bridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create invitation")
      ?.click(),
  );
  return {
    container,
    button: (label: string) =>
      [...container.querySelectorAll("button")].find((node) => node.textContent === label),
    /** Re-renders as after a host push of the device list. */
    async push() {
      bindings.pushed = { status: "ready" };
      await act(async () => root.render(<Harness />));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it.each(["relay_off", "no_config"] as const)(
  "a %s refusal says sync must be on first",
  async (code) => {
    const view = await created({
      invite: vi.fn(async () => ({ kind: "refused" as const, code })),
      confirm: vi.fn(),
      inspect: vi.fn(),
      cancel: vi.fn(),
    });
    try {
      expect(view.container.textContent).toContain("Turn on sync first");
      expect(view.container.textContent).not.toContain("could not be paired");
    } finally {
      await view.close();
    }
  },
);

it("shows the code as text under the QR and copies exactly that text", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = await created({
    invite: vi.fn(async () => ({
      kind: "ready" as const,
      operationId: "0".repeat(26),
      qr: "synthetic-code-text",
      expiresAt: Date.now() + 60_000,
    })),
    confirm: vi.fn(),
    inspect: vi.fn(),
    cancel: vi.fn(async () => ({ kind: "cancelled" as const })),
  });
  try {
    expect(view.container.textContent).toContain("Code to paste on the phone");
    expect(view.container.querySelector("code")?.textContent).toBe("synthetic-code-text");
    await act(async () => view.button("Copy code")?.click());
    expect(writeText).toHaveBeenCalledWith("synthetic-code-text");
  } finally {
    await view.close();
  }
});

it("offers a new code once the invitation expired", async () => {
  const invite = vi.fn(async () => ({
    kind: "ready" as const,
    operationId: "0".repeat(26),
    qr: "synthetic-expiring",
    expiresAt: Date.now() - 1,
  }));
  const view = await created({
    invite,
    confirm: vi.fn(),
    inspect: vi.fn(),
    cancel: vi.fn(async () => ({ kind: "cancelled" as const })),
  });
  try {
    expect(view.container.textContent).toContain("Invitation expired.");
    await act(async () => view.button("Show a new code")?.click());
    expect(invite).toHaveBeenCalledTimes(2);
  } finally {
    await view.close();
  }
});

it("waits for the phone's first sync and asks inspect again on each host push until completed", async () => {
  const operationId = "0".repeat(26);
  const device = "d".repeat(32);
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ kind: "waiting_for_phone", operationId })
    .mockResolvedValueOnce({ kind: "completed", operationId });
  const view = await created({
    invite: vi.fn(async () => ({
      kind: "ready" as const,
      operationId,
      qr: "synthetic-waiting",
      expiresAt: Date.now() + 60_000,
    })),
    confirm: vi.fn(async () => ({ kind: "waiting_for_phone" as const, operationId, device })),
    inspect,
    cancel: vi.fn(async () => ({ kind: "cancelled" as const })),
  });
  try {
    const input = view.container.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "123456",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => view.button("Confirm code")?.click());
    expect(view.container.textContent).toContain("Waiting for its first sync");
    expect(view.container.textContent).not.toContain("Phone paired.");
    expect(view.container.querySelector("code")).toBeNull();
    // Entering the waiting state reads once; the phone has not synced yet.
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Waiting for its first sync");
    // No timer: nothing more without a push.
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(inspect).toHaveBeenCalledTimes(1);
    await view.push();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenLastCalledWith({ vault: bindings.vault, operationId });
    expect(view.container.textContent).toContain("Phone paired.");
  } finally {
    await view.close();
  }
});
