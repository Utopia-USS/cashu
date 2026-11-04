// @vitest-environment jsdom
// The cash and asset drawers are portaled Modals, so their stories render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import assetDrawer, { Privacy as PrivateAsset } from "./AssetDrawerView.stories.js";
import cashDrawer, {
  Empty as EmptyCash,
  Privacy as PrivateCash,
  Ready as ReadyCash,
} from "./CashDrawerView.stories.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
beforeEach(() => setLanguageForTests("en"));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});
async function mount(node: ReactNode) {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return document.body;
}

it("renders the cash drawer stories as a named dialog and masks titles in privacy mode", async () => {
  const ready = await mount(
    <cashDrawer.component {...cashDrawer.args} {...ReadyCash} privacy={false} />,
  );
  expect(ready.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Cash wallet");
  expect(ready.textContent).toContain("Synthetic purchase");
  const empty = await mount(
    <cashDrawer.component {...cashDrawer.args} {...EmptyCash.args} privacy={false} />,
  );
  expect(empty.innerHTML).toContain("groceries");
  const hidden = await mount(
    PrivateCash.decorators[0]?.(() => <cashDrawer.component {...cashDrawer.args} privacy />),
  );
  expect(hidden.textContent).not.toContain("Synthetic purchase");
});

it("renders the asset drawer story as a named dialog and nothing in privacy mode", async () => {
  const ready = await mount(<assetDrawer.component {...assetDrawer.args} />);
  expect(ready.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("New position");
  expect(ready.querySelector('[role="dialog"] form')).not.toBeNull();
  const hidden = await mount(
    <assetDrawer.component {...assetDrawer.args} {...PrivateAsset.args} />,
  );
  expect(hidden.querySelector('[role="dialog"]')).toBeNull();
});
