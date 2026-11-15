// @vitest-environment jsdom
import { D } from "@cashu/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCategoriesDrawer } from "./useCategoriesDrawer.js";

const mock = vi.hoisted(() => ({
  rows: [] as {
    merchantKey: string;
    sample: string;
    count: number;
    total: unknown;
    currency: string;
  }[],
  runs: [] as { merchantKey: string; category: string }[],
}));
vi.mock("@cashu/store-react", () => ({
  useQuery: () => mock.rows,
  useCommand: () => ({ isPending: false }),
}));
vi.mock("@cashu/ui", () => ({ useToast: () => () => {} }));
vi.mock("../../useDurableCommand.js", () => ({
  commandFailure: () => "failed",
  useDurableCommands: () => ({
    run: (_key: string, _command: unknown, input: { merchantKey: string; category: string }) => {
      mock.runs.push(input);
      return Promise.resolve({ kind: "completed", value: { changed: true, updated: 1 } });
    },
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Probe() {
  const state = useCategoriesDrawer({ currency: "PLN", onClose: () => {} });
  return (
    <div data-error={state.error ?? ""}>
      {state.rows.map((r) => (
        <button key={r.key} type="button" data-key={r.key} onClick={() => r.choose("groceries")} />
      ))}
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
  mock.runs.length = 0;
});

const group = (merchantKey: string, sample: string) => ({
  merchantKey,
  sample,
  count: 2,
  total: D("10.00"),
  currency: "PLN",
});

it("lists no row (so no rule offer) for a bank's generic phrase", async () => {
  mock.rows = [
    group("PRZELEW", "PRZELEW"),
    group("KAWIARNIA ZXQ", "KAWIARNIA ZXQ"),
    group("ZAKUP PRZY UZYCIU KARTY", "ZAKUP PRZY UŻYCIU KARTY"),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((b) => b.getAttribute("data-key"))).toEqual(["KAWIARNIA ZXQ"]);
  await act(async () => {
    buttons[0]?.click();
  });
  expect(mock.runs).toEqual([{ merchantKey: "KAWIARNIA ZXQ", category: "groceries" }]);
  expect(container.firstElementChild?.getAttribute("data-error")).toBe("");
});
