// Execute the pure CSF Views without a store, router, host, DOM shim or financial-data substitute.
import { setLanguageForTests } from "@cashu/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import overview, {
  Empty,
  LegacyUnavailable,
  Privacy,
  Ready,
} from "./screens/overview/OverviewView.stories.js";
import bootstrap, { Failed, Waiting } from "./shell/BootstrapView.stories.js";
import shell, {
  LegacyUnavailable as LegacyShell,
  Privacy as PrivateShell,
  Ready as ReadyShell,
  Reconnecting,
  Toast,
} from "./shell/ShellView.stories.js";

beforeEach(() => setLanguageForTests("en"));

it("renders waiting and failed bootstrap CSF states before a store connection", () => {
  expect(renderToStaticMarkup(<bootstrap.component {...bootstrap.args} {...Waiting} />)).toContain(
    'role="status"',
  );
  expect(
    renderToStaticMarkup(<bootstrap.component {...bootstrap.args} {...Failed.args} />),
  ).toContain('role="alert"');
});

it("renders actual Overview CSF states and masks exact accessible amounts in its privacy decorator", () => {
  expect(renderToStaticMarkup(<overview.component {...overview.args} {...Ready} />)).toContain(
    'data-testid="net-worth"',
  );
  expect(renderToStaticMarkup(<overview.component {...overview.args} {...Empty.args} />)).toContain(
    'data-testid="net-worth"',
  );
  expect(
    renderToStaticMarkup(<overview.component {...overview.args} {...LegacyUnavailable.args} />),
  ).toContain("disabled");
  const hidden = renderToStaticMarkup(
    Privacy.decorators[0]?.(() => <overview.component {...overview.args} />),
  );
  expect(hidden).not.toContain("12,000");
  expect(hidden).not.toContain("11,000");
  expect(hidden).toContain("hidden");
});

it("renders actual shell CSF states without enabling disabled legacy navigation", () => {
  expect(renderToStaticMarkup(<shell.component {...shell.args} {...ReadyShell} />)).toContain(
    "Synthetic",
  );
  expect(renderToStaticMarkup(<shell.component {...shell.args} {...LegacyShell.args} />)).toContain(
    "disabled",
  );
  expect(
    renderToStaticMarkup(<shell.component {...shell.args} {...PrivateShell.args} />),
  ).toContain("checked");
  expect(
    renderToStaticMarkup(<shell.component {...shell.args} {...Reconnecting.args} />),
  ).toContain("Reconnecting");
  expect(renderToStaticMarkup(<shell.component {...shell.args} {...Toast.args} />)).toContain(
    "Profile changed.",
  );
});
