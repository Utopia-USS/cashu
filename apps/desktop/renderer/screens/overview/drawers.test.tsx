// @vitest-environment jsdom
// The cash and asset drawers are portaled Drawers, so their stories render into a DOM document.
import { setLanguageForTests } from "@cashu/i18n";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import assetDrawer, { Masked as MaskedAsset } from "./AssetDrawerView.stories.js";
import cashDrawer, { Empty as EmptyCash, Ready as ReadyCash } from "./CashDrawerView.stories.js";

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

it("renders the cash drawer stories as a named dialog with the transaction titles", async () => {
  const ready = await mount(<cashDrawer.component {...cashDrawer.args} {...ReadyCash} />);
  expect(ready.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Cash in the wallet",
  );
  expect(ready.textContent).toContain("Synthetic purchase");
  const empty = await mount(<cashDrawer.component {...cashDrawer.args} {...EmptyCash.args} />);
  expect(empty.innerHTML).toContain("groceries");
});

it("renders the asset drawer story as a named dialog, an incognito edit with dotted money fields", async () => {
  const ready = await mount(<assetDrawer.component {...assetDrawer.args} />);
  expect(ready.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Assets");
  expect(ready.querySelector('[role="dialog"] form')).not.toBeNull();
  const masked = await mount(<assetDrawer.component {...assetDrawer.args} {...MaskedAsset.args} />);
  const value = masked.querySelector<HTMLInputElement>(
    '[role="dialog"] input[inputmode="decimal"]',
  );
  expect(value?.value).toBe("");
  expect(value?.placeholder).toBe("•••");
});
