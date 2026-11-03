import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { D } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import {
  bridgeToken,
  dashboardWindow,
  expect,
  hostPid,
  launchDesktop,
  stopHost,
  test,
  until,
} from "../electron-test.ts";

function paths() {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (repo === undefined || dataDir === undefined) throw new Error("native demo setup is absent");
  return {
    repo,
    dataDir,
    loader: join(repo, "tools", "node-ts", "resolveTs.ts"),
    helper: join(repo, "apps", "host", "src", "testing", "seedOverviewDemo.ts"),
  };
}

test("the actual native Overview reads genuine demo stores, isolates profiles, preserves privacy and updates live", async () => {
  const { repo, dataDir, loader, helper } = paths();
  const host: ChildProcess = spawn(process.execPath, ["--import", loader, helper, "serve"], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let hostError = "";
  host.stderr?.on("data", (chunk) => {
    hostError += String(chunk);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await until(() => hostPid(dataDir) !== null || host.exitCode !== null);
    expect(host.exitCode, hostError).toBeNull();
    app = await launchDesktop({ dataDir, env: { CASHU_DESKTOP_NATIVE_OVERVIEW: "1" } });
    const { page, origin } = await dashboardWindow(app);
    await expect(page).toHaveURL(/\/assets\/desktop\/index\.html/);
    await expect(page.getByRole("heading", { name: "Przegląd", exact: true })).toBeVisible();
    // Delay the real handshake once, without replacing a page, port or provider. Bootstrap must
    // already show localized UI while createPortClient is awaiting its first ready.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("overview-port-delayed") === "1") return;
      let delayed = false;
      window.addEventListener(
        "message",
        (event) => {
          if (
            delayed ||
            (event.data as { cashu?: unknown })?.cashu !== "store-port" ||
            event.ports.length === 0
          )
            return;
          delayed = true;
          sessionStorage.setItem("overview-port-delayed", "1");
          event.stopImmediatePropagation();
          setTimeout(
            () => window.postMessage({ cashu: "store-port" }, location.origin, [...event.ports]),
            2_000,
          );
        },
        true,
      );
    });
    await page.reload();
    await expect(page.getByText("Otwieranie danych lokalnych…", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Przegląd", exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page).toHaveURL(/#\/demo-anna\/overview/);
    await expect(
      page
        .getByRole("navigation", { name: "Moduły" })
        .getByRole("button", { name: "Inwestycje", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo" });
    await expect(page).toHaveURL(/#\/demo\/overview/);
    await expect(page.getByRole("navigation", { name: "Moduły" }).getByRole("button")).toHaveCount(
      2,
    );
    await expect(
      page.getByRole("navigation", { name: "Moduły" }).getByRole("button", { name: "Ustawienia" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Moduły" }).getByRole("button", { name: "Ustawienia" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Tego profilu nie można jednoznacznie otworzyć w poprzednim widoku."),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page).toHaveURL(/#\/demo-anna\/overview/);
    const token = await bridgeToken(page);
    const summary = async (slug: string) => {
      const response = await page.request.get(`${origin}/api/p/${slug}/summary`, {
        headers: { "X-Cashu-Token": token },
      });
      expect(response.ok()).toBe(true);
      return (await response.json()) as {
        breakdown: { net: number; currency: string };
        networth: Record<string, number>;
      };
    };
    const anna = await summary("demo-anna");
    const rendered = (value: number, currency: string, locale = "pl-PL") =>
      formatDecimalValue(D(String(value)), locale, { currency }).text;
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(anna.breakdown.net, anna.breakdown.currency),
    );
    const headline = (await page.getByTestId("net-worth").textContent()) ?? "";
    if (Object.keys(anna.networth).includes("EUR")) {
      await page.getByRole("combobox", { name: "Waluta" }).selectOption("EUR");
      await expect(page).toHaveURL(/currency=EUR/);
      await expect(page.getByTestId("net-worth")).toHaveText(headline);
    }
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Piotr" });
    await expect(page).toHaveURL(/#\/demo-piotr\/overview/);
    const piotr = await summary("demo-piotr");
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(piotr.breakdown.net, piotr.breakdown.currency),
    );
    expect(piotr.breakdown.net).not.toBe(anna.breakdown.net);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await expect(page.getByTestId("net-worth")).toHaveText(headline);
    const seriesResponse = await page.request.get(
      `${origin}/api/p/demo-anna/networth/series?granularity=monthly&scope=total`,
      { headers: { "X-Cashu-Token": token } },
    );
    const series = (await seriesResponse.json()) as {
      currency: string;
      points: { date: string; value: number }[];
    };
    const chartControl = page.getByRole("group", { name: /^Historia wartości netto/ });
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText(
      rendered(series.points.at(-1)?.value ?? 0, series.currency),
    );
    await page.getByRole("checkbox", { name: "Ukryj kwoty" }).check();
    await expect(page.getByTestId("net-worth")).not.toContainText(/\d/);
    const chart = page.getByRole("img", { name: /^Historia wartości netto/ });
    await expect(chart).not.toHaveAttribute("aria-label", /\d/);
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText("•••");
    await page.getByRole("button", { name: "Pełny przegląd i pozostałe widoki" }).click();
    await expect(page).toHaveURL(/\?native=1#\/demo-anna\/overview/);
    await expect(page.getByRole("button", { name: "Pokaż kwoty" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("section.hero .h1 .v")).not.toContainText(/\d/);
    await page.getByRole("button", { name: "Pokaż kwoty" }).click();
    await expect(page.locator("section.hero .h1 .v")).toContainText(/\d/);
    await page.getByRole("link", { name: "Lokalny przegląd" }).click();
    await expect(page.getByRole("checkbox", { name: "Ukryj kwoty" })).not.toBeChecked();
    await expect(page.getByTestId("net-worth")).toHaveText(headline);
    await page.getByRole("combobox", { name: "Język" }).selectOption("en");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(anna.breakdown.net, anna.breakdown.currency, "en-US"),
    );
    await page.getByRole("combobox", { name: "Language" }).selectOption("pl");
    await expect(page.getByTestId("net-worth")).toHaveText(headline);
    // Native T24 command over the actual app socket. It changes only the native demo vault.
    const changed = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        join(repo, "apps", "cli", "src", "index.ts"),
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
    await expect(page.getByTestId("net-worth")).not.toHaveText(headline);
    await expect(page.getByTestId("net-worth")).toHaveText(
      rendered(anna.breakdown.net - 1, anna.breakdown.currency),
    );
    if (process.env.E2E_OVERVIEW_SCREENSHOT !== undefined)
      await page.screenshot({ path: process.env.E2E_OVERVIEW_SCREENSHOT, fullPage: true });
    // The renderer MessagePort stays alive while main replaces its host socket. The standard
    // restarted host deliberately has no demo-only cache binding (S53b lifecycle remains open).
    const oldPid = hostPid(dataDir);
    if (oldPid === null) throw new Error("native host disappeared");
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
    await expect.poll(() => hostPid(dataDir)).not.toBe(oldPid);
    await expect
      .poll(
        async () =>
          await page.evaluate(() =>
            (
              window as unknown as { nativeConnectionHistory: string[] }
            ).nativeConnectionHistory.join(" "),
          ),
      )
      .toMatch(/Połączenie przywrócone/);
    // Drive one genuine registered command on a second host socket. The assertion is the original
    // production renderer's profile option, so status-only recovery cannot satisfy this proof.
    const renamed = spawnSync(process.execPath, ["--import", loader, helper, "rename"], {
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(renamed.status, renamed.stderr).toBe(0);
    await expect(
      page.getByRole("combobox", { name: "Profil", exact: true }).locator("option:checked"),
    ).toHaveText("Demo E2E");
  } finally {
    if (app !== undefined) await app.close().catch(() => {});
    await stopHost(dataDir);
    if (host.exitCode === null) host.kill("SIGTERM");
  }
});
