import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StoreToClient } from "@cashu/host-protocol/store";
import { decodeValue } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";
import {
  currentVault,
  dashboardWindow,
  expect,
  launchDesktop,
  openProfileMenuItem,
  pickLanguage,
  pickProfile,
  rewriteHash,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

type Profile = { name: string; baseCurrency: string; mcpPrivacy: "strict" | "amounts" };
type Proposal = { gid: string; kind: string; status: string; summary: string };

/** Read the actual generated Store through the same host query channel as the renderer. */
async function readStore<T>(
  dataDir: string,
  vault: string,
  query: string,
  args:
    | { status: "pending" | "rejected"; privacy: boolean }
    | { gid: string; privacy: boolean }
    | { lang: "pl"; privacy: false; selection: null }
    | null = null,
): Promise<T> {
  if (dataDir !== process.env.E2E_NATIVE_DATA_DIR || !process.env.E2E_ROOT)
    throw new Error("synthetic_settings_root_required");
  const connection = await connectHost({ dataDir, role: "ui", build: "electron102" });
  try {
    return await new Promise<T>((resolve, reject) => {
      connection.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "ready") {
          if (!message.vaults.includes(vault)) {
            reject(new Error("synthetic_settings_vault_absent"));
            return;
          }
          connection.send({ t: "store", m: { t: "uiPolicy", generation: 1, privacy: false } });
          connection.send({
            t: "store",
            m: {
              t: "sub",
              sid: 102,
              generation: 1,
              resume: false,
              target: { kind: "vault", vault },
              query,
              args,
            },
          });
        } else if (message.t === "value" && message.sid === 102) {
          resolve(decodeValue(message.value) as T);
        } else if (message.t === "error") {
          reject(new Error(`synthetic_settings_query_failed:${query}:${message.error.name}`));
        }
      });
      connection.onClose(() => reject(new Error("synthetic_settings_connection_closed")));
    });
  } finally {
    connection.close();
  }
}

test("native Settings persists an atomic profile edit and reviews stored proposals within one vault", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("generated native demo is absent");
  await restoreNativeBaseline(dataDir);
  const visualRoot = process.env.CASHU_E2E_VISUALS;
  const visualPrefix = "/Users/owner/cashu-lab/checkpoints/visuals/S55j";
  const visuals =
    process.env.CASHU_TESTING === "1" &&
    visualRoot &&
    (resolve(visualRoot) === visualPrefix || resolve(visualRoot).startsWith(`${visualPrefix}/`))
      ? resolve(visualRoot)
      : null;
  if (visuals) mkdirSync(visuals, { recursive: true });
  const host: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      join(repo, "tools/node-ts/resolveTs.ts"),
      join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
      "serve",
    ],
    { env: { ...process.env, CASHU_E2E_SETTINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  host.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await until(
      () =>
        (existsSync(join(dataDir, "overview-ready")) &&
          readFileSync(join(dataDir, "overview-ready"), "utf8").trim() === String(host.pid)) ||
        host.exitCode !== null,
    );
    expect(host.exitCode, errors).toBeNull();
    app = await launchDesktop({ dataDir });
    const { page } = await dashboardWindow(app);
    // The vault ids come from the route once the pill shows the host-confirmed profile.
    await pickProfile(page, "Demo Piotr");
    const piotrOption = currentVault(page);
    await pickProfile(page, "Demo Anna");
    const anna = currentVault(page);
    if (!anna || !piotrOption || anna === piotrOption)
      throw new Error("synthetic vault pair absent");
    const openSettings = () => rewriteHash(page, /\/overview(?=\?|$)/u, "/settings");
    // Ustawienia sits in the profile menu (Python app layout).
    await openProfileMenuItem(page, "Ustawienia");
    await expect(page).toHaveURL(/\/settings(?:\?|$)/u);
    const profile = page.getByRole("region", { name: "Profil", exact: true });
    await expect(profile).toBeVisible();
    const original = await readStore<Profile>(dataDir, anna, "core.profile");
    const otherOriginal = await readStore<Profile>(dataDir, piotrOption, "core.profile");
    await profile
      .getByRole("textbox", { name: "Nazwa", exact: true })
      .fill("Synthetic Settings102");
    await profile.getByRole("combobox", { name: "Waluta bazowa" }).selectOption("EUR");
    await profile.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(profile.getByRole("textbox", { name: "Nazwa" })).toHaveValue(
      "Synthetic Settings102",
    );
    await expect
      .poll(async () => readStore<Profile>(dataDir, anna, "core.profile"))
      .toMatchObject({ name: "Synthetic Settings102", baseCurrency: "EUR" });
    expect(await readStore<Profile>(dataDir, piotrOption, "core.profile")).toMatchObject(
      otherOriginal,
    );
    await pickProfile(page, "Demo Piotr");
    await expect(page).toHaveURL(/\/overview(?:\?|$)/u);
    await openSettings();
    await expect(profile).toBeVisible();
    await expect(profile.getByRole("textbox", { name: "Nazwa" })).toHaveValue(otherOriginal.name);
    // Anna carries the name saved above.
    await pickProfile(page, "Synthetic Settings102");
    await expect(page).toHaveURL(/\/overview(?:\?|$)/u);
    await openSettings();
    await expect(profile).toBeVisible();
    await expect(profile.getByRole("textbox", { name: "Nazwa" })).toHaveValue(
      "Synthetic Settings102",
    );
    await profile.getByRole("textbox", { name: "Nazwa" }).fill(original.name);
    await profile
      .getByRole("combobox", { name: "Waluta bazowa" })
      .selectOption(original.baseCurrency);
    await profile.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect
      .poll(async () => readStore<Profile>(dataDir, anna, "core.profile"))
      .toMatchObject({ name: original.name, baseCurrency: original.baseCurrency });

    const agent = page.getByRole("region", { name: "Agent AI (MCP)" });
    const nextPrivacy = original.mcpPrivacy === "strict" ? "amounts" : "strict";
    await agent
      .locator(`input[name="mcp-privacy"]`)
      .nth(nextPrivacy === "strict" ? 0 : 1)
      .click();
    await expect
      .poll(async () => (await readStore<Profile>(dataDir, anna, "core.profile")).mcpPrivacy)
      .toBe(nextPrivacy);
    await expect(
      agent.locator(`input[name="mcp-privacy"]`).nth(nextPrivacy === "strict" ? 0 : 1),
    ).toBeChecked();
    expect((await readStore<Profile>(dataDir, piotrOption, "core.profile")).mcpPrivacy).toBe(
      otherOriginal.mcpPrivacy,
    );
    await agent
      .locator(`input[name="mcp-privacy"]`)
      .nth(original.mcpPrivacy === "strict" ? 0 : 1)
      .click();
    await expect
      .poll(async () => (await readStore<Profile>(dataDir, anna, "core.profile")).mcpPrivacy)
      .toBe(original.mcpPrivacy);
    await expect(
      agent.locator(`input[name="mcp-privacy"]`).nth(original.mcpPrivacy === "strict" ? 0 : 1),
    ).toBeChecked();

    const rows = await readStore<Proposal[]>(dataDir, anna, "core.desktopProposals.list", {
      status: "pending",
      privacy: true,
    });
    expect(rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["budget_import", "custom_rule", "import", "strategy"]),
    );
    const strategyGid = rows.find((row) => row.kind === "strategy")?.gid;
    if (!strategyGid) throw new Error("synthetic_settings_strategy_absent");
    expect(
      await readStore<{ gid: string; payload: object }>(
        dataDir,
        anna,
        "core.desktopProposals.detail",
        { gid: strategyGid, privacy: true },
      ),
    ).toMatchObject({ gid: strategyGid, payload: {} });
    expect(
      await readStore<{ gid: string; display: { diffAvailability: string } }>(
        dataDir,
        anna,
        "core.desktopProposals.detail",
        { gid: strategyGid, privacy: false },
      ),
    ).toMatchObject({ gid: strategyGid, display: { diffAvailability: "ready" } });
    expect(
      await readStore<Proposal[]>(dataDir, piotrOption, "core.desktopProposals.list", {
        status: "pending",
        privacy: true,
      }),
    ).toEqual([]);
    const proposals = agent.getByRole("region", { name: "Propozycje agenta" });
    const drawer = page.getByRole("dialog", { name: "Propozycja agenta" });
    if (visuals)
      await page.screenshot({ path: join(visuals, "electron102-settings.png"), fullPage: true });
    const firstOpener = proposals
      .getByRole("button", { name: "Otwórz propozycję" })
      .filter({ hasText: "Synthetic Settings102 strategy" });
    await firstOpener.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(firstOpener).toBeFocused();
    const detailChecks: ReadonlyArray<[string, string]> = [
      ["Synthetic Settings102 strategy", "Zmiana w strategy.yaml"],
      ["Synthetic Settings102 rule", "Test wsteczny"],
      ["Synthetic Settings102 investment import", "synthetic-investment.csv"],
      ["Synthetic Settings102 budget import", "synthetic-statement.csv"],
    ];
    for (const [summary, content] of detailChecks) {
      await proposals
        .getByRole("button", { name: "Otwórz propozycję" })
        .filter({ hasText: summary })
        .click();
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(summary);
      await expect(drawer).toContainText(content);
      if (visuals && summary === "Synthetic Settings102 strategy")
        await page.screenshot({
          path: join(visuals, "electron102-strategy-diff.png"),
          fullPage: true,
        });
      if (visuals && summary === "Synthetic Settings102 budget import")
        await page.screenshot({
          path: join(visuals, "electron102-budget-import.png"),
          fullPage: true,
        });
      await drawer.getByRole("button", { name: "Zamknij" }).click();
    }
    await proposals
      .getByRole("button", { name: "Otwórz propozycję" })
      .filter({ hasText: "Synthetic Settings102 strategy" })
      .click();
    await drawer.getByRole("button", { name: "Odrzuć" }).click();
    await expect(drawer).toHaveCount(0);
    await expect
      .poll(async () =>
        readStore<Proposal[]>(dataDir, anna, "core.desktopProposals.list", {
          status: "rejected",
          privacy: true,
        }),
      )
      .toContainEqual(expect.objectContaining({ gid: strategyGid, status: "rejected" }));
    await expect(
      proposals
        .getByRole("button", { name: "Otwórz propozycję" })
        .filter({ hasText: "Synthetic Settings102 strategy" }),
    ).toHaveCount(0);

    const incognito = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await incognito.click();
    await expect(incognito).toBeChecked();
    await expect(proposals).not.toContainText("Synthetic Settings102 rule");
    await proposals.getByRole("button", { name: "Otwórz propozycję" }).first().click();
    await expect(drawer).toHaveCount(0);
    await incognito.click();
    await expect(incognito).not.toBeChecked();
    await expect(drawer).toHaveCount(0);
    await expect(proposals).toContainText("Synthetic Settings102 rule");
    await rewriteHash(page, /\/settings(?=\?|$)/u, "/investments.strategies");
    const strategies = page.getByTestId("native-strategies");
    await expect(strategies).toBeVisible();
    const strategyState = await readStore<{ proposals: Proposal[] }>(
      dataDir,
      anna,
      "investments.strategies.screen",
      { lang: "pl", privacy: false, selection: null },
    );
    expect(strategyState.proposals.map((row) => row.summary)).toContain(
      "Synthetic Settings102 rule",
    );
    // The ported status card (ab24ab6 StrategyPopover + Header.tsx ProposalNotice): the first pending
    // proposal with `Zobacz`, which opens the proposal drawer.
    const notice = strategies.getByRole("button", { name: "Zobacz", exact: true });
    await notice.scrollIntoViewIfNeeded();
    await notice.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Zamknij" }).click();
    await rewriteHash(page, /\/investments\.strategies(?=\?|$)/u, "/settings");
    await expect(profile).toBeVisible();
    await pickProfile(page, "Demo Piotr");
    await expect(page).toHaveURL(/\/overview(?:\?|$)/u);
    await openSettings();
    await expect(profile).toBeVisible();
    await expect(agent.getByText("Brak oczekujących propozycji.")).toBeVisible();
    await pickLanguage(page, "English");
    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "Language", exact: true })
        .getByRole("button", { name: "English", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await pickLanguage(page, "Polski");
    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "Język", exact: true })
        .getByRole("button", { name: "Polski", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    if (app) {
      await app.close().catch(() => {});
      await stopHost(dataDir).catch(() => {});
    }
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null);
    }
  }
});
