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

test("Research page reads generated events, opens a note and a topic, and separates profiles", async () => {
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
    // The research page in place of the Home grid (ab24ab6 v2/research/Page.tsx: crumb, head, story, tabs).
    const research = page.getByTestId("native-research");
    await expect(research).toBeVisible();
    const researchHash = await page.evaluate(() => location.hash);
    const tab = (name: string) => research.getByRole("tab", { name, exact: true });
    await tab("Notatki").click();
    const fact1 = research.getByRole("button", { name: "Synthetic research fact 1", exact: true });
    await expect(fact1).toBeVisible();
    await fact1.click();
    await expect(fact1).toHaveAttribute("aria-expanded", "true");
    await expect(
      research.getByRole("link", { name: "Synthetic publisher" }).first(),
    ).toHaveAttribute("href", "https://example.test/research/1");
    await research.getByRole("button", { name: "otwórz →" }).click();
    // The asset drawer over the investments Home (ab24ab6 `assets/{id}?note=`) opens with the note's row.
    const asset = page.getByRole("dialog").last();
    await expect(asset).toBeVisible();
    await expect(asset.getByText("Synthetic research fact 1").first()).toBeVisible();
    await settleModalHistory(page);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, researchHash);
    await expect(research).toBeVisible();
    await tab("Tematy").click();
    // A topic card's headline opens the topic drawer over the Home (old `topics/<key>`).
    const firstTopic = research.locator("article[data-topic] h3 button").first();
    await firstTopic.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.locator("[data-topic-drawer]")).toBeVisible();
    const topicLabel = await drawer.getAttribute("aria-label");
    const ownerThesis = "Synthetic owner thesis typed in Electron101";
    const ownerView = "Synthetic market assessment typed in Electron101";
    const thesis = drawer.locator("#topic-thesis");
    await thesis.getByRole("button", { name: /^(Dodaj|Edytuj)$/u }).click();
    await thesis.getByRole("textbox", { name: "Teza", exact: true }).fill(ownerThesis);
    await thesis.getByRole("button", { name: "Zapisz" }).click();
    await expect(page.getByText("Zapisano tezę", { exact: true })).toBeVisible();
    await thesis.getByRole("button", { name: "Edytuj" }).click();
    await thesis.getByRole("textbox", { name: "Ocena teraz" }).fill(ownerView);
    await thesis.getByRole("button", { name: "Zapisz" }).click();
    await expect(page.getByText("Zapisano ocenę", { exact: true })).toBeVisible();
    const current = await readNativeResearchTopics(dataDir, selectedVault);
    const savedTopic = current.topics.find((item) => item.thesis?.thesis === ownerThesis);
    expect(savedTopic?.thesis?.assessment).toBe(ownerView);
    await expect(thesis.getByText(ownerThesis, { exact: true })).toBeVisible();
    await expect(thesis.getByText(ownerView, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await settleModalHistory(page);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, researchHash);
    await expect(research).toBeVisible();
    await tab("Tematy").click();
    await research.locator("article[data-topic] h3 button").first().click();
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-label", topicLabel as string);
    await expect(
      page.getByRole("dialog").locator("#topic-thesis").getByText(ownerThesis, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await settleModalHistory(page);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, researchHash);
    await expect(research).toBeVisible();
    await tab("Notatki").click();
    const more = research.getByRole("button", { name: /^pokaż jeszcze \d+$/u });
    while (await more.count()) await more.click();
    const finalFixtureNote = research.getByRole("button", {
      name: "Synthetic research fact 100",
      exact: true,
    });
    await finalFixtureNote.scrollIntoViewIfNeeded();
    await expect(finalFixtureNote).toBeVisible();
    await finalFixtureNote.click();
    await expect(finalFixtureNote).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path:
        process.env.E2E_RESEARCH_SCREENSHOT ??
        join(repo, "apps/desktop/dist/e2e-run/results/native-research.png"),
      fullPage: true,
    });
    // Kandydaci: old CandidateCard with Obserwuj / Odrzuć; the answer's undo sits in the toast.
    await tab("Kandydaci").click();
    const unresolved = research.locator("[data-note]").filter({ hasText: "Synthetic Candidate" });
    await expect(unresolved.first()).toBeVisible();
    await unresolved.first().getByRole("button", { name: "Odrzuć" }).click();
    const dismissedToast = page.getByRole("status").filter({ hasText: "Odrzucono kandydata" });
    await expect(dismissedToast).toBeVisible();
    await dismissedToast.getByRole("button", { name: "Cofnij" }).click();
    await expect(page.getByText("Cofnięto: odrzucenie kandydata")).toBeVisible();
    const resolved = research
      .locator("[data-note]")
      .filter({ hasText: "Synthetic Resolved Candidate" });
    await resolved.getByRole("button", { name: "Obserwuj" }).click();
    const watchedToast = page.getByRole("status").filter({ hasText: "Dodano do obserwowanych" });
    await expect(watchedToast).toBeVisible();
    await watchedToast.getByRole("button", { name: "Cofnij" }).click();
    await expect(page.getByText("Cofnięto: obserwowanie")).toBeVisible();
    await tab("Kalendarz").click();
    await expect(research.getByText(/CPI/u).first()).toBeVisible();
    const screenshot = process.env.E2E_RESEARCH_SCREENSHOT;
    if (screenshot)
      await page.screenshot({
        path: screenshot.replace(/\.png$/u, "-calendar.png"),
        fullPage: true,
      });
    await tab("Przebiegi").click();
    await expect(research.getByText("zakończony", { exact: true }).first()).toBeVisible();
    // Privacy mode hides the research text (native rule, kept over the old app's parity).
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
