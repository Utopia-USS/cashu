import {
  currentVault,
  expect,
  pickProfile,
  rewriteHash,
  setPrivacy,
  settleModalHistory,
  test,
} from "../electron-test.ts";
import { readHostQuery } from "../host-query.ts";
import { openNativeDemo } from "../native-baseline.ts";

type ResearchScreen = {
  topics: { key: string; thesis: { thesis: string | null; assessment: string | null } | null }[];
};

test("Research: a note and its asset, an owner topic thesis, a candidate answer, incognito and profiles", async () => {
  const demo = await openNativeDemo({ env: { CASHU_E2E_RESEARCH: "1" } });
  const { page, dataDir } = demo;
  try {
    const vault = currentVault(page);
    const readTopics = () =>
      readHostQuery<ResearchScreen>(dataDir, vault, "investments.research.screen", {
        today: new Date().toISOString().slice(0, 10),
        lang: "pl",
      });
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/investments.research");
    const research = page.getByTestId("native-research");
    await expect(research).toBeVisible();
    const researchHash = await page.evaluate(() => location.hash);
    const backToResearch = async () => {
      await page.keyboard.press("Escape");
      await settleModalHistory(page);
      await page.evaluate((hash) => {
        location.hash = hash;
      }, researchHash);
      await expect(research).toBeVisible();
    };
    const tab = (name: string) => research.getByRole("tab", { name, exact: true });

    // A note opens with its source link and leads to its asset's drawer.
    await tab("Notatki").click();
    const fact1 = research.getByRole("button", { name: "Synthetic research fact 1", exact: true });
    await fact1.click();
    await expect(fact1).toHaveAttribute("aria-expanded", "true");
    await expect(
      research.getByRole("link", { name: "Synthetic publisher" }).first(),
    ).toHaveAttribute("href", "https://example.test/research/1");
    await research.getByRole("button", { name: "otwórz →" }).click();
    await expect(
      page.getByRole("dialog").last().getByText("Synthetic research fact 1").first(),
    ).toBeVisible();
    await backToResearch();

    // The topic drawer (its route `?topic=` over the investments Home): the owner's thesis and
    // assessment are stored.
    const topicKey = (await readTopics()).topics
      .map((item) => item.key)
      .find((key) => /^[a-z0-9_]{1,120}$/u.test(key));
    if (!topicKey) throw new Error("synthetic_research_topic_absent");
    await page.evaluate(
      ([hash, key]) => {
        const [path = "", query = ""] = hash.slice(1).split("?");
        const vaultParam = query.split("&").find((part) => part.startsWith("vault="));
        const search = [vaultParam, `topic=${key}`].filter(Boolean).join("&");
        location.hash = `${path.replace("/investments.research", "/investments.portfolio")}?${search}`;
      },
      [researchHash, topicKey] as const,
    );
    const thesis = page.getByRole("dialog").locator("#topic-thesis");
    const ownerThesis = "Synthetic owner thesis typed in Electron101";
    const ownerView = "Synthetic market assessment typed in Electron101";
    await thesis.getByRole("button", { name: /^(Dodaj|Edytuj)$/u }).click();
    await thesis.getByRole("textbox", { name: "Teza", exact: true }).fill(ownerThesis);
    await thesis.getByRole("button", { name: "Zapisz" }).click();
    await expect(page.getByText("Zapisano tezę", { exact: true })).toBeVisible();
    await thesis.getByRole("button", { name: "Edytuj" }).click();
    await thesis.getByRole("textbox", { name: "Bieżąca ocena" }).fill(ownerView);
    await thesis.getByRole("button", { name: "Zapisz" }).click();
    await expect(page.getByText("Zapisano ocenę", { exact: true })).toBeVisible();
    const saved = (await readTopics()).topics.find((item) => item.thesis?.thesis === ownerThesis);
    expect(saved?.thesis?.assessment).toBe(ownerView);
    await backToResearch();

    // A candidate's answer is undone from its toast.
    await tab("Kandydaci").click();
    const candidate = research.locator("[data-note]").filter({ hasText: "Synthetic Candidate" });
    await candidate.first().getByRole("button", { name: "Odrzuć" }).click();
    const dismissedToast = page.getByRole("status").filter({ hasText: "Odrzucono kandydata" });
    await dismissedToast.getByRole("button", { name: "Cofnij" }).click();
    await expect(page.getByText("Cofnięto: odrzucenie kandydata")).toBeVisible();

    // Incognito hides only money: the research text stays readable; another profile never sees it.
    await tab("Notatki").click();
    await setPrivacy(page, true);
    await tab("Notatki").click();
    await expect(fact1).toBeVisible();
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Piotr");
    await expect(page.getByText("Synthetic research fact 1", { exact: true })).toHaveCount(0);
  } finally {
    await demo.close();
  }
});
