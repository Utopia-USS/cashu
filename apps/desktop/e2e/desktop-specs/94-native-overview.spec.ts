import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { demoExpectations, negate, plus, rendered } from "../demo-expectations.ts";
import {
  alive,
  appDir,
  dashboardWindow,
  electronBinary,
  expect,
  hostPid,
  launchEnv,
  pickProfile,
  rewriteHash,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

/** A whole amount as the Python Przegląd widgets show it (old `cur0s`: no decimals). */
function rendered0(amount: string, currency: string, locale = "pl-PL"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: "always",
  } as Intl.NumberFormatOptions).format(Math.round(Number(amount)));
}

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
  await restoreNativeBaseline(dataDir);
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
    const expected = demoExpectations();
    await expect(page.getByTestId("net-worth")).toBeVisible();
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    await expect(page).toHaveURL(/\/overview/u);
    const annaWorth = rendered(expected.anna.net, expected.anna.currency);
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const budgetWidget = page.getByRole("region", { name: /^Budżet · /u });
    await expect(budgetWidget).toBeVisible();
    const budgetText = (await budgetWidget.textContent()) ?? "";
    const chosen = Object.values(expected.anna.months).find((month) =>
      budgetText.includes(rendered0(month.income, month.currency)),
    );
    if (!chosen) throw new Error("native budget month is outside the synthetic expectations");
    for (const amount of [chosen.income, chosen.spending, chosen.surplus])
      await expect(budgetWidget).toContainText(rendered0(amount, chosen.currency));

    const accountsWidget = page.getByRole("region", { name: "Konta", exact: true });
    await expect(accountsWidget).toBeVisible();
    const listed = expected.anna.accounts.filter(
      (account) =>
        ["checking", "savings", "credit", "investment", "other"].includes(account.type) &&
        !(account.bank === "manual" && account.type === "other") &&
        account.amount !== null &&
        Math.abs(Number(account.amount)) >= 0.005,
    );
    await expect(accountsWidget.locator("tbody tr")).toHaveCount(listed.length);
    for (const account of listed)
      if (account.amount !== null)
        await expect(accountsWidget).toContainText(rendered(account.amount, account.currency));
    await accountsWidget.getByRole("button").last().click();
    await expect(page.getByRole("dialog", { name: "Gotówka w portfelu" })).toBeVisible();
    await pickProfile(page, "Demo");
    await expect(page.getByRole("dialog", { name: "Gotówka w portfelu" })).toHaveCount(0);
    // Przegląd only: Ustawienia moved into the profile menu (Python app layout).
    await expect(page.getByRole("navigation", { name: "Moduły" }).getByRole("button")).toHaveCount(
      1,
    );
    await pickProfile(page, "Demo Anna");
    await expect(page.getByRole("dialog", { name: "Gotówka w portfelu" })).toHaveCount(0);

    const assets = expected.anna.assets;
    const assetsWidget = page.getByRole("region", { name: "Majątek", exact: true });
    await expect(assetsWidget.locator("tbody tr")).toHaveCount(Math.min(assets.length, 5));
    for (const asset of assets.slice(0, 5))
      if (asset.amount !== null)
        await expect(assetsWidget).toContainText(rendered0(asset.amount, asset.currency));
    const loansWidget = page.getByRole("region", { name: "Kredyty", exact: true });
    if (expected.anna.loans.length > 0) {
      await expect(loansWidget.locator("tbody tr")).toHaveCount(expected.anna.loans.length);
      for (const loan of expected.anna.loans)
        await expect(loansWidget).toContainText(rendered(negate(loan.outstanding), loan.currency));
    }
    // The investments hero fact (old InvestmentsHeroFact: whole units).
    await expect(page.getByRole("region", { name: "Wartość netto", exact: true })).toContainText(
      rendered0(expected.anna.investments.value, expected.anna.investments.currency),
    );
    await pickProfile(page, "Demo Piotr");
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(expected.piotr.net, expected.piotr.currency),
    );
    expect(expected.piotr.net).not.toBe(expected.anna.net);
    await pickProfile(page, "Demo Anna");
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const chartControl = page.getByRole("group", { name: /^Wartość netto w czasie/u });
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText(
      rendered(expected.anna.seriesEnd.value, expected.anna.seriesEnd.currency),
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
    // The chart label keeps its month range ("maj 26"); amounts are hidden.
    await expect(page.getByRole("img", { name: /^Wartość netto w czasie/u })).not.toHaveAttribute(
      "aria-label",
      /\d{3}|\d\s?zł/u,
    );
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText("•••");
    await privacy.click();
    await expect(privacy).not.toBeChecked();
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    // The language lives in Settings, as in the Python app.
    await rewriteHash(page, /\/overview(?=\?|$)/u, "/settings");
    await page
      .getByRole("group", { name: "Język", exact: true })
      .getByRole("button", { name: "English", exact: true })
      .click();
    await expect(
      page
        .getByRole("group", { name: "Language", exact: true })
        .getByRole("button", { name: "English", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await rewriteHash(page, /\/settings(?=\?|$)/u, "/overview");
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(expected.anna.net, expected.anna.currency, "en-US"),
    );
    await rewriteHash(page, /\/overview(?=\?|$)/u, "/settings");
    await page
      .getByRole("group", { name: "Language", exact: true })
      .getByRole("button", { name: "Polski", exact: true })
      .click();
    await expect(
      page
        .getByRole("group", { name: "Język", exact: true })
        .getByRole("button", { name: "Polski", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await rewriteHash(page, /\/settings(?=\?|$)/u, "/overview");
    await expect(page.getByTestId("net-worth")).toHaveText(annaWorth);
    const editIndex = assets.findIndex(
      (asset) =>
        asset.kind === "manual" &&
        asset.currency === expected.anna.currency &&
        asset.amount !== null,
    );
    if (editIndex < 0) throw new Error("synthetic demo lacks an editable base-currency asset");
    const edited = assets[editIndex];
    if (!edited || edited.amount === null) throw new Error("synthetic asset valuation is absent");
    await assetsWidget.locator("tbody tr").nth(editIndex).getByRole("button").click();
    const editDialog = page.getByRole("dialog", { name: "Majątek", exact: true });
    await editDialog
      .getByRole("textbox", { name: "Wartość", exact: true })
      .fill(plus(edited.amount, "1"));
    await editDialog.getByRole("textbox", { name: "Notatka" }).fill("Synthetic UI note");
    await editDialog.getByRole("button", { name: "Zapisz" }).click();
    await expect(editDialog).toHaveCount(0);
    await expect(assetsWidget).toContainText(rendered0(plus(edited.amount, "1"), edited.currency));
    await expect(assetsWidget.getByText("notatka", { exact: true })).toBeVisible();
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(plus(expected.anna.net, "1"), expected.anna.currency),
    );
    await assetsWidget.getByRole("button", { name: "+ Dodaj" }).click();
    const assetDialog = page.getByRole("dialog", { name: "Majątek", exact: true });
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
      rendered(plus(expected.anna.net, "-1"), expected.anna.currency),
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
