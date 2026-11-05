import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoreToClient } from "@cashu/host-protocol/store";
import { decodeValue } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";
import { z } from "zod";
import {
  currentVault,
  dashboardWindow,
  expect,
  launchDesktop,
  pickProfile,
  rewriteHash,
  setPrivacy,
  settleModalHistory,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

const researchTopicsShape = z.object({
  status: z.literal("current"),
  topics: z.array(
    z.object({
      key: z.string(),
      thesis: z
        .object({ thesis: z.string().nullable(), assessment: z.string().nullable() })
        .nullable(),
    }),
  ),
});

async function readNativeResearchTopics(dataDir: string, vault: string) {
  if (dataDir !== process.env.E2E_NATIVE_DATA_DIR || !process.env.E2E_ROOT)
    throw new Error("synthetic_research_root_required");
  const connection = await connectHost({ dataDir, role: "ui", build: "electron101" });
  try {
    return await new Promise<z.infer<typeof researchTopicsShape>>((resolve, reject) => {
      connection.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "ready") {
          if (!message.vaults.includes(vault)) reject(new Error("synthetic_research_vault_absent"));
          connection.send({ t: "store", m: { t: "uiPolicy", generation: 0, privacy: false } });
          connection.send({
            t: "store",
            m: {
              t: "sub",
              sid: 101,
              generation: 0,
              resume: false,
              target: { kind: "vault", vault },
              query: "investments.research.screen",
              args: { today: new Date().toISOString().slice(0, 10), lang: "pl" },
            },
          });
        } else if (message.t === "value" && message.sid === 101) {
          const result = researchTopicsShape.safeParse(decodeValue(message.value));
          if (result.success) resolve(result.data);
          else reject(new Error("synthetic_research_projection_invalid"));
        } else if (message.t === "error") reject(new Error("synthetic_research_query_failed"));
      });
      connection.onClose(() => reject(new Error("synthetic_research_connection_closed")));
    });
  } finally {
    connection.close();
  }
}

test("native Research reads generated events, opens a note, and separates vault privacy", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  await restoreNativeBaseline(dataDir);
  const host: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      join(repo, "tools/node-ts/resolveTs.ts"),
      join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
      "serve",
    ],
    { env: { ...process.env, CASHU_E2E_RESEARCH: "1" }, stdio: ["ignore", "ignore", "pipe"] },
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
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    const selectedVault = currentVault(page);
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/investments.research");
    const research = page.getByTestId("native-research");
    await expect(research).toBeVisible();
    const researchHash = await page.evaluate(() => location.hash);
    await research.getByRole("button", { name: "Notatki", exact: true }).click();
    await expect(research.getByText("Synthetic research fact 1", { exact: true })).toBeVisible();
    await research.getByRole("button", { name: /^Synthetic research fact 1(?:\s|$)/u }).click();
    const reader = page.getByRole("dialog", { name: "Szczegóły" });
    await expect(reader.getByText("Synthetic research fact 1", { exact: true })).toBeVisible();
    await expect(reader.getByRole("link", { name: "Synthetic publisher" })).toHaveAttribute(
      "href",
      "https://example.test/research/1",
    );
    await reader.getByRole("button", { name: "Otwórz aktywo" }).click();
    const asset = page.getByTestId("native-asset-research");
    await expect(asset).toBeVisible();
    const deepNote = asset.getByRole("button", { name: "Synthetic research fact 1", exact: true });
    await expect(deepNote).toBeVisible();
    await expect(deepNote).toBeFocused();
    await settleModalHistory(page);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, researchHash);
    await expect(research).toBeVisible();
    await research.getByRole("button", { name: "Tematy", exact: true }).click();
    const firstTopic = research
      .getByRole("heading", { name: "Tematy", exact: true })
      .locator("..")
      .locator("ul li button")
      .first();
    await firstTopic.click();
    const drawer = page.getByRole("dialog");
    const topicLabel = await drawer.getAttribute("aria-label");
    const ownerThesis = "Synthetic owner thesis typed in Electron101";
    const ownerView = "Synthetic market assessment typed in Electron101";
    await drawer.getByRole("textbox", { name: "Teza", exact: true }).fill(ownerThesis);
    await drawer.getByRole("textbox", { name: "Ocena rynku" }).fill(ownerView);
    await expect(drawer.getByRole("textbox", { name: "Teza", exact: true })).toHaveValue(
      ownerThesis,
    );
    await expect(drawer.getByRole("textbox", { name: "Ocena rynku" })).toHaveValue(ownerView);
    const draftConfirmation = drawer.getByRole("checkbox", {
      name: "Potwierdzam przyjęcie szkicu agenta",
    });
    if (await draftConfirmation.count()) await draftConfirmation.check();
    await drawer.getByRole("button", { name: "Zapisz" }).click();
    await expect(research.getByRole("status").filter({ hasText: "Zapisano" })).toBeVisible();
    const current = await readNativeResearchTopics(dataDir, selectedVault);
    const savedTopic = current.topics.find((item) => item.thesis?.thesis === ownerThesis);
    expect(savedTopic?.thesis?.assessment).toBe(ownerView);
    await expect(research.getByText(`Ocena rynku: ${ownerView}`, { exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Anuluj" }).click();
    await firstTopic.click();
    await expect(drawer).toHaveAttribute("aria-label", topicLabel as string);
    await expect(drawer.getByRole("textbox", { name: "Teza", exact: true })).toHaveValue(
      ownerThesis,
    );
    await expect(drawer.getByRole("textbox", { name: "Ocena rynku" })).toHaveValue(ownerView);
    await drawer.getByRole("button", { name: "Anuluj" }).click();
    await research.getByRole("button", { name: "Notatki", exact: true }).click();
    const more = research.getByRole("button", { name: "Pokaż więcej" });
    while (await more.count()) await more.click();
    const notesViewport = research.getByRole("region", { name: "Notatki" });
    const finalFixtureNote = research.getByRole("button", { name: "Synthetic research fact 100" });
    for (let step = 0; step < 20 && !(await finalFixtureNote.isVisible()); step++) {
      await notesViewport.evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollTop + element.clientHeight,
          element.scrollHeight,
        );
      });
    }
    await expect(finalFixtureNote).toBeVisible();
    await finalFixtureNote.click();
    await expect(page.getByRole("dialog", { name: "Szczegóły" })).toContainText(
      "Synthetic research fact 100",
    );
    await page
      .getByRole("dialog", { name: "Szczegóły" })
      .getByRole("button", { name: "Zamknij" })
      .click();
    await page.screenshot({
      path:
        process.env.E2E_RESEARCH_SCREENSHOT ??
        join(repo, "apps/desktop/dist/e2e-run/results/native-research.png"),
      fullPage: true,
    });
    await research.getByRole("button", { name: "Kandydaci", exact: true }).click();
    await expect(research.getByText("Synthetic research fact 3", { exact: true })).toBeVisible();
    await research.getByRole("button", { name: "Synthetic research fact 3" }).click();
    const candidate = page.getByRole("dialog", { name: "Szczegóły" });
    await expect(candidate.getByRole("button", { name: "Obserwuj" })).toBeDisabled();
    await expect(
      candidate.getByText("Nie można potwierdzić instrumentu dla tego kandydata"),
    ).toBeVisible();
    await candidate.getByRole("button", { name: "Odrzuć" }).click();
    await expect(candidate.getByRole("button", { name: "Cofnij odrzucenie" })).toBeVisible();
    await candidate.getByRole("button", { name: "Cofnij odrzucenie" }).click();
    await expect(candidate.getByRole("button", { name: "Odrzuć" })).toBeVisible();
    await candidate.getByRole("button", { name: "Zamknij" }).click();
    await research.getByRole("button", { name: "Synthetic research fact 4" }).click();
    const resolved = page.getByRole("dialog", { name: "Szczegóły" });
    await expect(resolved.getByRole("button", { name: "Obserwuj" })).toBeEnabled();
    await resolved.getByRole("button", { name: "Obserwuj" }).click();
    await expect(resolved.getByRole("button", { name: "Cofnij obserwowanie" })).toBeVisible();
    await resolved.getByRole("button", { name: "Cofnij obserwowanie" }).click();
    await expect(resolved.getByRole("button", { name: "Obserwuj" })).toBeVisible();
    await resolved.getByRole("button", { name: "Zamknij" }).click();
    await research.getByRole("button", { name: "Kalendarz", exact: true }).click();
    await expect(research.getByText(/CPI/u)).toBeVisible();
    const screenshot = process.env.E2E_RESEARCH_SCREENSHOT;
    if (screenshot)
      await page.screenshot({
        path: screenshot.replace(/\.png$/u, "-calendar.png"),
        fullPage: true,
      });
    await research.getByRole("button", { name: "Przebiegi", exact: true }).click();
    await expect(research.getByText("Zakończony", { exact: true }).first()).toBeVisible();
    await setPrivacy(page, true);
    await expect(research.getByText("Synthetic research fact 1", { exact: true })).toHaveCount(0);
    await expect(research.getByText("Ukryte w trybie prywatności", { exact: true })).toBeVisible();
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Piotr");
    await expect(page.getByText("Synthetic research fact 1", { exact: true })).toHaveCount(0);
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
