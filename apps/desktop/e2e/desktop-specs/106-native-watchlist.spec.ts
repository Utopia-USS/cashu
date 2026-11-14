/// <reference types="node" />
// The Signals watchlist actions on a host in production vault mode. Every other Signals spec serves
// the synthetic harness host, which registers every UI action; the shipped host registered them only
// with an injected market provider, so "+ Dodaj" in Obserwowane was refused in the installed app.
// Here a real Create runs against the supervised native-production host (nativeCreationHost.ts,
// no Signals provider injected), and the window sends the watchlist actions through its store port.
import type { Page } from "@playwright/test";
import { dashboardWindow, expect, storeHarnessWindow, test, until } from "../electron-test.ts";
import { nativeCreationHarness } from "../native-creation-support.ts";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function createWithInvestments(page: Page): Promise<void> {
  const wizard = page.locator('[data-testid="native-creation"]');
  await expect(wizard).toBeVisible();
  await wizard.getByRole("textbox", { name: "Nazwa profilu" }).fill("Synthetic Watch");
  await wizard.getByRole("textbox", { name: "Nazwa tego urządzenia" }).fill("Test computer");
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await expect(wizard.getByText(/Krok 2 z 3/)).toBeVisible();
  const investments = wizard.getByRole("checkbox", { name: /Inwestycje/ });
  await investments.check();
  await expect(investments).toBeChecked();
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await wizard.getByRole("radio", { name: /Ścisły/ }).check();
  await wizard.getByRole("button", { name: /Dalej/ }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="recovery-phrase"]') !== null,
  );
  await wizard.getByRole("checkbox", { name: /Zapisałem lub zapisałam frazę/ }).check();
  await wizard.getByRole("button", { name: "Utwórz bezpieczny profil" }).click();
}

function action(page: Page, id: string, input: unknown): Promise<unknown> {
  return page.evaluate(
    ([actionId, actionInput]) =>
      (
        window as unknown as {
          cashuStoreAction(id: string, input: unknown): Promise<unknown>;
        }
      ).cashuStoreAction(actionId as string, actionInput),
    [id, input] as const,
  );
}

test("the watchlist add, search and remove reach a production-mode host", async () => {
  const harness = nativeCreationHarness();
  try {
    const host = await harness.startHost();
    const app = await harness.launchDesktop();
    const { page } = await dashboardWindow(app);
    await createWithInvestments(page);
    // Create hands the data dir over (exit 75); the supervisor starts the host again.
    expect(await host.exited).toBe(75);
    const restarted = await harness.startHost();
    await page.getByRole("button", { name: "Pomiń workspace" }).click();
    await expect(page).toHaveURL(/\/overview/u);

    const store = await storeHarnessWindow(app);
    const search = (await action(store, "investments.signals.search", { query: "NEW.WA" })) as {
      status: string;
      value?: { remote_status?: string };
    };
    expect(search.status, JSON.stringify(search)).toBe("completed");
    // No public-market provider in this host: the add works offline, unverified (old Python too).
    expect(search.value?.remote_status).toBe("unavailable");
    const added = (await action(store, "investments.signals.watch", {
      target: { kind: "text", text: "NEW.WA" },
    })) as { status: string; value?: { ok?: boolean; value?: { item?: string } } };
    expect(added.status, JSON.stringify(added)).toBe("completed");
    expect(added.value?.ok, JSON.stringify(added)).toBe(true);
    const item = added.value?.value?.item;
    expect(typeof item).toBe("string");
    const removed = (await action(store, "investments.signals.removeWatch", { item })) as {
      status: string;
    };
    expect(removed.status, JSON.stringify(removed)).toBe("completed");
    await app.close();
    await restarted.stop();
    await until(() => restarted.child.exitCode !== null || restarted.child.signalCode !== null);
  } finally {
    await harness.cleanup();
  }
});
