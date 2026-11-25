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
  // The host pushes each vault's checked settings.
  useQuery: () => ({
    status: "ready",
    snapshot: {
      backend: mock.vault === "a".repeat(32) ? "anthropic" : "ollama",
      model: "claude-haiku-4-5",
      consented: mock.vault === "a".repeat(32),
      keyPresent: true,
    },
  }),
  useUiAction: () => ({
    run: () =>
      new Promise((resolve) => {
        mock.calls.push({ vault: mock.vault, resolve });
      }),
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Probe() {
  const screen = useClassificationScreen();
  return (
    <div data-vault={screen.vault}>
      {screen.snapshot?.backend}:{screen.notice ?? ""}
      <button type="button" onClick={() => void screen.revokeCloud()} />
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

it("drops a delayed old-profile change outcome after selecting another vault", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  expect(container.textContent).toBe("anthropic:");
  await act(async () => {
    container?.querySelector("button")?.click();
  });
  expect(mock.calls).toHaveLength(1);
  mock.vault = "b".repeat(32);
  await act(async () => {
    root?.render(<Probe />);
  });
  await act(async () => {
    mock.calls[0]?.resolve({ status: "outcome_unknown", reason: "interrupted" });
  });
  expect(container.textContent).toBe("ollama:");
  expect(container.firstElementChild?.getAttribute("data-vault")).toBe("b".repeat(32));
});
