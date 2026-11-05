/// <reference types="node" />
// Real Electron renderer -> own-origin preload -> authenticated host RPC -> encrypted native vault.
// The host is supervised with a persisted fake OS KeyStore. The Electron bootstrap denies ordinary
// detached host spawning throughout both handovers and the later renderer restart.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  currentVault,
  dashboardWindow,
  expect,
  openProfileMenuItem,
  profileCount,
  profilePill,
  test,
  until,
} from "../electron-test.ts";
import { nativeCreationHarness, type TestHost } from "../native-creation-support.ts";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function createThroughWizard(page: Page, visualRoot?: string): Promise<void> {
  const wizard = page.locator('[data-testid="native-creation"]');
  await expect(wizard).toBeVisible();
  await wizard.getByRole("textbox", { name: "Nazwa profilu" }).fill("Synthetic Create");
  await wizard.getByRole("combobox", { name: "Waluta bazowa" }).selectOption("EUR");
  await wizard.getByRole("textbox", { name: "Nazwa tego urządzenia" }).fill("Test computer");
  if (visualRoot) await page.screenshot({ path: join(visualRoot, "01-profile.png") });
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await expect(wizard.getByText(/Krok 2 z 3/)).toBeVisible();
  if (visualRoot) await page.screenshot({ path: join(visualRoot, "02-modules.png") });
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await wizard.getByRole("radio", { name: /Ścisły/ }).check();
  if (visualRoot) await page.screenshot({ path: join(visualRoot, "03-privacy.png") });
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="recovery-phrase"]') !== null,
  );
  // Only scalar evidence crosses from the renderer. The phrase never enters the test process.
  const phraseState = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="recovery-phrase"]');
    return {
      visible: element !== null && element.getClientRects().length > 0,
      count: element?.textContent?.trim().split(/\s+/u).length ?? 0,
    };
  });
  expect(phraseState).toEqual({ visible: true, count: 24 });
  await expect(wizard.getByRole("button", { name: "Utwórz bezpieczny profil" })).toBeDisabled();
  await wizard.getByRole("checkbox", { name: /Zapisałem lub zapisałam frazę/ }).check();
  await wizard.getByRole("button", { name: "Utwórz bezpieczny profil" }).click();
  expect(
    await page.evaluate(() => document.querySelector('[data-testid="recovery-phrase"]') === null),
  ).toBe(true);
}

async function skipUnavailableWorkspace(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: "Pomiń workspace" });
  await expect(skip).toBeVisible();
  await skip.click();
}

async function restartHostAfterHandover(
  host: TestHost,
  deniedMarker: string,
  previousDenials: number,
  start: () => Promise<TestHost>,
): Promise<TestHost> {
  expect(await host.exited).toBe(75);
  await until(() => denialCount(deniedMarker) > previousDenials, 5_000);
  return start();
}

function denialCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("blocked\n").length - 1 : 0;
}

test("first native Create, explicit Add, authenticated handover, and read-only restart", async () => {
  const visualRoot = test.info().outputPath("native-create");
  mkdirSync(visualRoot, { recursive: true, mode: 0o700 });
  const harness = nativeCreationHarness();
  try {
    let host = await harness.startHost();
    const app = await harness.launchDesktop();
    let page = (await dashboardWindow(app)).page;
    const deniedMarker = `${harness.dataDir}/test-spawn-denied`;
    await createThroughWizard(page, visualRoot);
    host = await restartHostAfterHandover(host, deniedMarker, 0, () => harness.startHost());
    await skipUnavailableWorkspace(page);
    await expect(profilePill(page)).toBeVisible();
    await expect.poll(() => profileCount(page)).toBe(1);
    const firstVault = currentVault(page);
    expect(firstVault).toMatch(/^[0-9a-f]{32}$/u);
    await expect(page).toHaveURL(/\/overview/u);
    expect(page.url()).toContain(firstVault);
    expect(
      await page.evaluate(() => document.querySelector('[data-testid="recovery-phrase"]') === null),
    ).toBe(true);
    await page.screenshot({ path: join(visualRoot, "04-first-ready.png") });
    const firstDenials = denialCount(deniedMarker);
    expect(firstDenials).toBeGreaterThan(0);
    const firstStatus = await page.evaluate(() =>
      (
        window as unknown as { cashuCreation: { current(): Promise<{ kind: string }> } }
      ).cashuCreation.current(),
    );
    expect(firstStatus.kind).toBe("ready");

    // A completed anchor may coexist with a fresh explicit Add, even with the same name and slug.
    await openProfileMenuItem(page, "Nowy profil…");
    await createThroughWizard(page);
    host = await restartHostAfterHandover(host, deniedMarker, firstDenials, () =>
      harness.startHost(),
    );
    await skipUnavailableWorkspace(page);
    await expect.poll(() => profileCount(page)).toBe(2);
    const secondVault = currentVault(page);
    expect(secondVault).toMatch(/^[0-9a-f]{32}$/u);
    expect(secondVault).not.toBe(firstVault);
    await expect(page).toHaveURL(/\/overview/u);
    expect(page.url()).toContain(secondVault);
    expect(
      await page.evaluate(() => document.querySelector('[data-testid="recovery-phrase"]') === null),
    ).toBe(true);
    await page.screenshot({ path: join(visualRoot, "05-second-ready.png") });
    const secondStatus = await page.evaluate(() =>
      (
        window as unknown as { cashuCreation: { current(): Promise<{ kind: string }> } }
      ).cashuCreation.current(),
    );
    expect(secondStatus.kind).toBe("ready");

    await app.close();
    const restarted = await harness.launchDesktop();
    page = (await dashboardWindow(restarted)).page;
    await expect.poll(() => profileCount(page)).toBe(2);
    expect(
      await page.evaluate(() => document.querySelector('[data-testid="recovery-phrase"]') === null),
    ).toBe(true);
    const restartStatus = await page.evaluate(() =>
      (
        window as unknown as { cashuCreation: { current(): Promise<{ kind: string }> } }
      ).cashuCreation.current(),
    );
    expect(restartStatus.kind).toBe("ready");
    await host.stop();
  } finally {
    await harness.cleanup();
  }
});
