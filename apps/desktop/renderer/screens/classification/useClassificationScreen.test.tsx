// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useClassificationScreen } from "./useClassificationScreen.js";

const mock = vi.hoisted(() => ({
  vault: "a".repeat(32),
  calls: [] as { vault: string; resolve: (value: unknown) => void }[],
}));
vi.mock("@cashu/store-react", () => ({
  useProfile: () => mock.vault,
  useUiAction: () => ({
    run: () =>
      new Promise((resolve) => {
        mock.calls.push({ vault: mock.vault, resolve });
      }),
  }),
}));

const complete = (backend: "ollama" | "anthropic") => ({
  status: "completed",
  value: {
    backend,
    model: "claude-haiku-4-5",
    consented: backend === "anthropic",
    keyPresent: true,
  },
});
let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Probe() {
  const state = useClassificationScreen();
  return (
    <div data-vault={state.vault} data-backend={state.snapshot?.backend ?? ""}>
      {state.snapshot?.backend ?? "unavailable"}
    </div>
  );
}
afterEach(async () => {
  if (root)
    await act(async () => {
      root?.unmount();
    });
  container?.remove();
  root = null;
  container = null;
  mock.calls.length = 0;
  mock.vault = "a".repeat(32);
});

it("drops a delayed old-profile status after selecting another vault", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  expect(mock.calls).toHaveLength(1);
  mock.vault = "b".repeat(32);
  await act(async () => {
    root?.render(<Probe />);
  });
  expect(mock.calls).toHaveLength(2);
  await act(async () => {
    mock.calls[1]?.resolve(complete("ollama"));
  });
  expect(container.textContent).toBe("ollama");
  await act(async () => {
    mock.calls[0]?.resolve(complete("anthropic"));
  });
  expect(container.textContent).toBe("ollama");
  expect(container.firstElementChild?.getAttribute("data-vault")).toBe("b".repeat(32));
});

it("refuses a malformed completed status snapshot", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  await act(async () => {
    mock.calls[0]?.resolve({ status: "completed", value: { backend: "anthropic" } });
  });
  expect(container.textContent).toBe("unavailable");
  expect(container.firstElementChild?.getAttribute("data-backend")).toBe("");
});
