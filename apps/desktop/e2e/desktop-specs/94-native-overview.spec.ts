import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { _electron } from "@playwright/test";
import {
  alive,
  appDir,
  dashboardWindow,
  electronBinary,
  expect,
  hostPid,
  launchEnv,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";

function paths() {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native demo setup is absent");
  return {
    repo,
    dataDir,
    loader: join(repo, "tools/node-ts/resolveTs.ts"),
    helper: join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
  };
}

interface Summary {
  breakdown: { net: number; currency: string };
  networth: Record<string, number>;
}
interface Oracle {
  anna: {
    summary: Summary;
    monthCloses: Record<
      string,
      {
        base_currency: string;
        currencies: { currency: string; income: number; spending: number; surplus: number }[];
      }
    >;
    networth: {
      accounts: { type: string; bank: string; balance: number | null; currency: string }[];
    };
    assets: { balance: number | null; currency: string; kind: string; is_liability: boolean }[];
    loans: { outstanding: number; currency: string }[];
    investments: { base_currency: string; kpis: { value: { total: number } } };
    series: { currency: string; points: { date: string; value: number }[] };
  };
  piotr: { summary: Summary };
}

function oracle(): Oracle {
  const file = process.env.E2E_OVERVIEW_ORACLE;
  if (!file) throw new Error("isolated Overview oracle is absent");
  return JSON.parse(readFileSync(file, "utf8")) as Oracle;
}

function restoreExactOverviewBaseline(dataDir: string) {
  const root = process.env.E2E_ROOT;
  const baseline = process.env.E2E_NATIVE_BASELINE_DIR;
  const tempRoot = realpathSync(tmpdir());
  if (
    !root ||
    !baseline ||
    realpathSync(root) !== root ||
    !root.startsWith(`${tempRoot}/cashu-e2e-desktop-`) ||
    baseline !== join(root, "native-baseline") ||
    dataDir !== join(root, "native-data") ||
    realpathSync(baseline) !== baseline ||
    realpathSync(dataDir) !== dataDir
  )
    throw new Error("isolated Overview baseline paths are absent");
  const previous = hostPid(dataDir);
  if (previous !== null && alive(previous))
    throw new Error("synthetic Overview baseline restore refused while a host is live");
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(baseline, dataDir, { recursive: true });
}

async function launchGuardedOverview(dataDir: string) {
  const root = process.env.E2E_ROOT;
  if (!root || dataDir !== join(root, "native-data"))
    throw new Error("synthetic Overview root is absent");
  const privateApp = join(root, "overview-app");
  mkdirSync(privateApp, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(privateApp, "package.json"),
    JSON.stringify({ name: "cashu-native-overview-e2e", private: true, main: "bootstrap.cjs" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(privateApp, "bootstrap.cjs"),
    readFileSync(join(appDir(), "e2e", "native-overview-guard.cjs")),
    { mode: 0o600 },
  );
  return _electron.launch({
    executablePath: electronBinary(),
    args: [privateApp, "--lang=pl-PL"],
    env: launchEnv(dataDir, {
      E2E_NATIVE_OVERVIEW_MAIN: join(appDir(), "dist", "main.js"),
    }),
    timeout: 90_000,
  });
}

test("the native Overview reads isolated stores, preserves privacy, and updates live", async () => {
  const { repo, dataDir, loader, helper } = paths();
  restoreExactOverviewBaseline(dataDir);
  const host: ChildProcess = spawn(process.execPath, ["--import", loader, helper, "serve"], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let hostError = "";
  host.stderr?.on("data", (chunk) => {
    hostError += String(chunk);
  });
  let replacement: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof launchGuardedOverview>> | undefined;
  try {
    await until(() => existsSync(join(dataDir, "overview-ready")) || host.exitCode !== null);
    expect(host.exitCode, hostError).toBeNull();
    expect(hostPid(dataDir)).not.toBeNull();
    app = await launchGuardedOverview(dataDir);
    const { page, origin } = await dashboardWindow(app);
    expect(origin).toBe("app://cashu");
    const expected = oracle();
    const rendered = (value: number, currency: string, locale = "pl-PL") =>
      formatDecimalValue(D(String(value)), locale, { currency }).text;
    await expect(page.getByRole("heading", { name: "Przegląd", exact: true })).toBeVisible();
    await setPrivacy(page, false);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page).toHaveURL(/\/overview/u);
    const annaWorth = rendered(
      expected.anna.summary.breakdown.net,
      expected.anna.summary.breakdown.currency,
    );
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const budgetWidget = page.locator('section[aria-labelledby="overview-budget-month-title"]');
    await expect(budgetWidget).toBeVisible();
    const monthLabel = (await budgetWidget.locator("h2").textContent())?.match(/\d{4}-\d{2}/u)?.[0];
    if (!monthLabel) throw new Error("native budget month label is absent");
    const monthClose = expected.anna.monthCloses[monthLabel];
    if (!monthClose) throw new Error("native budget month is outside the isolated oracle range");
    const chosen =
      monthClose.currencies.find((row) => row.currency === monthClose.base_currency) ??
      monthClose.currencies[0];
    if (!chosen) throw new Error("synthetic oracle budget currency is absent");
    for (const amount of [chosen.income, chosen.spending, chosen.surplus])
      await expect(budgetWidget).toContainText(rendered(amount, chosen.currency));

    const accountsWidget = page.locator('section[aria-labelledby="overview-accounts-title"]');
    await expect(accountsWidget).toBeVisible();
    const listed = expected.anna.networth.accounts.filter(
      (account) =>
        ["checking", "savings", "credit", "investment", "other"].includes(account.type) &&
        !(account.bank === "manual" && account.type === "other") &&
        account.balance !== null &&
        Math.abs(account.balance) >= 0.005,
    );
    await expect(accountsWidget.locator("li")).toHaveCount(listed.length);
    for (const account of listed)
      if (account.balance !== null)
        await expect(accountsWidget).toContainText(rendered(account.balance, account.currency));
    await accountsWidget.getByRole("button").last().click();
    await expect(page.getByRole("dialog", { name: "Portfel gotówkowy" })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo" });
    await expect(page.getByRole("dialog", { name: "Portfel gotówkowy" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Moduły" }).getByRole("button")).toHaveCount(
      2,
    );
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page.getByRole("dialog", { name: "Portfel gotówkowy" })).toHaveCount(0);

    const assets = expected.anna.assets.filter((asset) => !asset.is_liability);
    const assetsWidget = page.locator('section[aria-labelledby="overview-assets-title"]');
    await expect(assetsWidget.locator("li")).toHaveCount(Math.min(assets.length, 5));
    for (const asset of assets.slice(0, 5))
      if (asset.balance !== null)
        await expect(assetsWidget).toContainText(rendered(asset.balance, asset.currency));
    const loansWidget = page.locator('section[aria-labelledby="overview-loans-title"]');
    if (expected.anna.loans.length > 0) {
      await expect(loansWidget.locator("li")).toHaveCount(expected.anna.loans.length);
      for (const loan of expected.anna.loans)
        await expect(loansWidget).toContainText(rendered(-loan.outstanding, loan.currency));
    }
    await expect(
      page.locator('section[aria-labelledby="overview-investments-title"]'),
    ).toContainText(
      rendered(expected.anna.investments.kpis.value.total, expected.anna.investments.base_currency),
    );
    if (Object.keys(expected.anna.summary.networth).includes("EUR")) {
      await page.getByRole("combobox", { name: "Waluta" }).selectOption("EUR");
      await expect(page).toHaveURL(/currency=EUR/u);
      await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    }
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Piotr" });
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(expected.piotr.summary.breakdown.net, expected.piotr.summary.breakdown.currency),
    );
    expect(expected.piotr.summary.breakdown.net).not.toBe(expected.anna.summary.breakdown.net);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const chartControl = page.getByRole("group", { name: /^Historia wartości netto/u });
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText(
      rendered(expected.anna.series.points.at(-1)?.value ?? 0, expected.anna.series.currency),
    );
    const privacy = page.getByRole("checkbox", { name: "Ukryj kwoty" });
    await privacy.click();
    const immediatePrivacy = await page.evaluate((exactWorth) => {
      const amount = document.querySelector('[data-testid="net-worth"]');
      const amountRetained = amount?.textContent?.includes(exactWorth) ?? false;
      return {
        overview: amount !== null,
        loading: document.body.textContent?.includes("Otwieranie danych lokalnych") ?? false,
        hostConnected:
          document
            .querySelector('[data-testid="host-connection"]')
            ?.textContent?.includes("Połączono") ?? false,
        checked: (document.querySelector('input[type="checkbox"]') as HTMLInputElement | null)
          ?.checked,
        amountRetained,
        exactAmountExposed:
          amountRetained &&
          amount !== null &&
          amount.getClientRects().length > 0 &&
          getComputedStyle(amount).visibility === "visible" &&
          amount.closest('[aria-hidden="true"], [inert]') === null,
      };
    }, annaWorth);
    const playwrightAmountVisible = await page
      .getByTestId("net-worth")
      .isVisible()
      .catch(() => false);
    const privacyEvidence = { ...immediatePrivacy, playwrightAmountVisible };
    process.stdout.write(`Overview privacy immediate: ${JSON.stringify(privacyEvidence)}\n`);
    await test.info().attach("overview-privacy-transition-scalar", {
      body: Buffer.from(JSON.stringify(privacyEvidence)),
      contentType: "application/json",
    });
    expect(immediatePrivacy.exactAmountExposed).toBe(false);
    if (immediatePrivacy.amountRetained) expect(playwrightAmountVisible).toBe(false);
    await expect(privacy).toBeChecked();
    await expect(page.getByTestId("net-worth")).not.toContainText(/\d/u);
    await expect(page.getByRole("img", { name: /^Historia wartości netto/u })).not.toHaveAttribute(
      "aria-label",
      /\d/u,
    );
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText("•••");
    await privacy.click();
    await expect(privacy).not.toBeChecked();
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    await page.getByRole("combobox", { name: "Język" }).selectOption("en");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(
        expected.anna.summary.breakdown.net,
        expected.anna.summary.breakdown.currency,
        "en-US",
      ),
    );
    await page.getByRole("combobox", { name: "Language" }).selectOption("pl");
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const editIndex = assets.findIndex(
      (asset) =>
        asset.kind === "manual" &&
        asset.currency === expected.anna.summary.breakdown.currency &&
        asset.balance !== null,
    );
    if (editIndex < 0) throw new Error("synthetic demo lacks an editable base-currency asset");
    const edited = assets[editIndex];
    if (!edited || edited.balance === null) throw new Error("synthetic asset valuation is absent");
    await assetsWidget.locator("li").nth(editIndex).getByRole("button").click();
    const editDialog = page.getByRole("dialog", { name: /^Edytuj: /u });
    await editDialog
      .getByRole("textbox", { name: "Wartość", exact: true })
      .fill(String(edited.balance + 1));
    await editDialog.getByRole("textbox", { name: "Notatka" }).fill("Synthetic UI note");
    await editDialog.getByRole("button", { name: "Zapisz" }).click();
    await expect(editDialog).toHaveCount(0);
    await expect(assetsWidget).toContainText(rendered(edited.balance + 1, edited.currency));
    await expect(assetsWidget.getByText("notatka", { exact: true })).toBeVisible();
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(expected.anna.summary.breakdown.net + 1, expected.anna.summary.breakdown.currency),
    );
    await assetsWidget.getByRole("button", { name: "+ Dodaj" }).click();
    const assetDialog = page.getByRole("dialog", { name: "Nowa pozycja", exact: true });
    await assetDialog.getByRole("combobox", { name: "Typ" }).selectOption("vehicle");
    await assetDialog.getByRole("textbox", { name: "Cena zakupu" }).fill("12000");
    const firstPreview = await assetDialog.getByText(/dziś ≈/u).textContent();
    await assetDialog.getByRole("textbox", { name: "Cena zakupu" }).fill("13000");
    await expect(assetDialog.getByText(/dziś ≈/u)).not.toHaveText(firstPreview ?? "");
    await assetDialog.getByRole("button", { name: "Anuluj" }).click();
    await expect(assetDialog).toHaveCount(0);
    const changed = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        join(repo, "apps/cli/src/index.ts"),
        "--profile",
        "demo-anna",
        "cash-add",
        "1",
        "Synthetic expense",
        "dining",
      ],
      {
        env: { ...process.env, CASHU_DATA_DIR: dataDir },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(changed.status, changed.stderr).toBe(0);
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    // No ordinary host may be launched when the first synthetic host exits. The private
    // Electron bootstrap refuses child spawns, and this replacement serves the same stores.
    const oldPid = hostPid(dataDir);
    if (oldPid === null) throw new Error("synthetic host disappeared before restart");
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="host-connection"]');
      const history: string[] = [];
      (window as unknown as { nativeConnectionHistory: string[] }).nativeConnectionHistory =
        history;
      if (node !== null)
        new MutationObserver(() => {
          history.push(node.textContent ?? "");
        }).observe(node, { childList: true, characterData: true, subtree: true });
    });
    process.kill(oldPid, "SIGTERM");
    await until(() => !alive(oldPid));
    replacement = spawn(process.execPath, ["--import", loader, helper, "serve"], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let replacementError = "";
    replacement.stderr?.on("data", (chunk) => {
      replacementError += String(chunk);
    });
    await until(() => {
      const pid = hostPid(dataDir);
      return pid !== null && pid !== oldPid && alive(pid);
    });
    expect(replacement.exitCode, replacementError).toBeNull();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { nativeConnectionHistory: string[] }).nativeConnectionHistory.join(
            " ",
          ),
        ),
      )
      .toContain("Połączenie przywrócone");
    const afterRestart = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        join(repo, "apps/cli/src/index.ts"),
        "--profile",
        "demo-anna",
        "cash-add",
        "1",
        "Synthetic expense after restart",
        "dining",
      ],
      { env: { ...process.env, CASHU_DATA_DIR: dataDir }, encoding: "utf8", timeout: 10_000 },
    );
    expect(afterRestart.status, afterRestart.stderr).toBe(0);
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(expected.anna.summary.breakdown.net - 1, expected.anna.summary.breakdown.currency),
    );
    const scoped = spawnSync(process.execPath, ["--import", loader, helper, "cross-profile"], {
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(scoped.stdout).toContain("scoped drawer commands: pass");
  } finally {
    if (app) await app.close().catch(() => {});
    await stopHost(dataDir);
    if (host.exitCode === null) host.kill("SIGTERM");
    if (replacement?.exitCode === null) replacement.kill("SIGTERM");
  }
});
