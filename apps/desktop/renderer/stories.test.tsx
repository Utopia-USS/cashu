// Execute the pure CSF Views without a store, router, host, DOM shim or financial-data substitute.
import { setLanguageForTests } from "@cashu/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import assets, {
  Empty as EmptyAssets,
  Open as OpenAssets,
  Privacy as PrivateAssets,
  Ready as ReadyAssets,
} from "./screens/overview/AssetsWidgetView.stories.js";
import investments, {
  Privacy as PrivateInvestments,
  Ready as ReadyInvestments,
  Unavailable as UnavailableInvestments,
  ZeroStart,
} from "./screens/overview/InvestmentsWidgetView.stories.js";
import minimal, {
  FirstDeposit,
  Planned,
  Privacy as PrivateMinimal,
  Ready as ReadyMinimal,
  Refused,
  Unavailable as UnavailableMinimal,
} from "./screens/overview/MinimalOverviewView.stories.js";
import overview, { Empty, Privacy, Ready } from "./screens/overview/OverviewView.stories.js";
import bootstrap, { Failed, Waiting } from "./shell/BootstrapView.stories.js";
import recovery, {
  ImportCancelled,
  ImportFailed,
  Importing,
  InventoryUnavailable,
  MigrationIncomplete,
  RecoveryWords,
  ReportUnavailable,
  Unknown as UnknownRecovery,
} from "./shell/RecoveryView.stories.js";
import shell, {
  NoProfile,
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

it("renders the start-up recovery CSF states without a host", () => {
  const render = (story: { args?: object } = {}) =>
    renderToStaticMarkup(<recovery.component {...recovery.args} {...story.args} />);
  expect(render()).toContain("Import my data");
  expect(render()).toContain('data-testid="recovery-code"');
  expect(render(Importing)).toContain('aria-current="step"');
  expect(render(RecoveryWords)).toContain('data-testid="migration-recovery-phrase"');
  expect(render(ImportCancelled)).toContain("nothing was created");
  expect(render(MigrationIncomplete)).toContain("Finish the import");
  for (const story of [ImportFailed, InventoryUnavailable, UnknownRecovery])
    expect(render(story)).not.toContain("Import my data");
  expect(render(ReportUnavailable)).toContain("could not be read");
});

it("renders actual Overview CSF states and masks exact accessible amounts in its privacy decorator", () => {
  expect(renderToStaticMarkup(<overview.component {...overview.args} {...Ready} />)).toContain(
    'data-testid="net-worth"',
  );
  expect(renderToStaticMarkup(<overview.component {...overview.args} {...Empty.args} />)).toContain(
    'data-testid="net-worth"',
  );
  // The ready Overview has no disabled control (Select classes carry `disabled:` variants, so
  // match the attribute, not the word).
  expect(renderToStaticMarkup(<overview.component {...overview.args} {...Ready} />)).not.toMatch(
    /\sdisabled(?:=|\s|>)/,
  );
  const hidden = renderToStaticMarkup(
    Privacy.decorators[0]?.(() => <overview.component {...overview.args} />),
  );
  expect(hidden).not.toContain("12,000");
  expect(hidden).not.toContain("11,000");
  expect(hidden).toContain("hidden");
});

it("renders asset and investment widget stories from synthetic state", () => {
  expect(renderToStaticMarkup(<assets.component {...assets.args} {...ReadyAssets} />)).toContain(
    "Synthetic property",
  );
  expect(
    renderToStaticMarkup(<assets.component {...assets.args} {...EmptyAssets.args} />),
  ).toContain("overview-assets-title");
  expect(
    renderToStaticMarkup(<assets.component {...assets.args} {...OpenAssets.args} />),
  ).toContain("Synthetic property");
  expect(
    renderToStaticMarkup(<assets.component {...assets.args} {...PrivateAssets.args} />),
  ).not.toContain("Synthetic property");
  expect(
    renderToStaticMarkup(<investments.component {...investments.args} {...ReadyInvestments} />),
  ).toContain("overview-investments-title");
  expect(
    renderToStaticMarkup(
      <investments.component {...investments.args} {...UnavailableInvestments.args} />,
    ),
  ).toContain('aria-label="Investments"');
  expect(
    renderToStaticMarkup(<investments.component {...investments.args} {...ZeroStart.args} />),
  ).toContain("overview-investments-title");
  expect(
    renderToStaticMarkup(
      PrivateInvestments.decorators[0]?.(() => <investments.component {...investments.args} />),
    ),
  ).toContain("overview-investments-title");
});

it("renders the investments-only overview stories in every phase", () => {
  const render = (story: { args?: object } = {}) =>
    renderToStaticMarkup(<minimal.component {...minimal.args} {...story.args} />);
  const ready = render(ReadyMinimal);
  expect(ready).toContain('data-testid="minimal-portfolio-value"');
  expect(ready).toContain("minimal-deposits-title");
  expect(ready).toContain('aria-current="step"');
  expect(ready).toContain(">Plan</button>");
  expect(render(Planned)).not.toContain(">Plan</button>");
  expect(render(FirstDeposit)).toContain("set it in the strategy");
  expect(render(Refused)).toContain('role="alert"');
  const unavailable = render(UnavailableMinimal);
  expect(unavailable).toContain('aria-label="Portfolio"');
  expect(unavailable).not.toContain("minimal-deposits-title");
  const hidden = renderToStaticMarkup(
    PrivateMinimal.decorators[0]?.(() => <minimal.component {...minimal.args} />),
  );
  expect(hidden).not.toContain("10,450");
  expect(hidden).toContain("hidden");
});

it("renders actual shell CSF states", () => {
  expect(renderToStaticMarkup(<shell.component {...shell.args} {...ReadyShell} />)).toContain(
    "Synthetic",
  );
  expect(renderToStaticMarkup(<shell.component {...shell.args} {...NoProfile.args} />)).toContain(
    "Synthetic",
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
