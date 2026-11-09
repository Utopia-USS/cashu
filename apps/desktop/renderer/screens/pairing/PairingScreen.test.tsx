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
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => bindings.vault,
  useConnection: () => bindings.connection,
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
