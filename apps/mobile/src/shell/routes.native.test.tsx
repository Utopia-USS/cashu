// The route tree's tab bar over the real store: the actual `(tabs)` layout under expo-router's test
// router (NativeTabs renders its react-native-screens host components in Jest), with stand-in tab
// roots. Investments is a tab only for a profile with the investments module, and follows a switch.
import { setLanguageForTests } from "@cashu/i18n";
import { setModules } from "@cashu/store";
import { setCurrentVault } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { act, renderRouter, screen } from "expo-router/testing-library";
import type { ReactNode } from "react";
import { Text } from "react-native";
import TabsLayout from "../../app/(tabs)/_layout";
import { applyMoneyCommand, MONEY_VAULT_B, moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";

interface Node {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly (Node | string)[] | null;
}

/** The titles of the tab bar items the native tab host would show (hidden ones excluded). */
function tabTitles(): string[] {
  const titles: string[] = [];
  const walk = (node: Node | string | null) => {
    if (node === null || typeof node === "string") return;
    if (node.type === "RNSTabsScreenIOS" && node.props.hidden !== true)
      titles.push(String(node.props.title));
    for (const child of node.children ?? []) walk(child);
  };
  const json = screen.toJSON() as Node | Node[] | null;
  for (const node of Array.isArray(json) ? json : [json]) walk(node);
  return titles;
}

it("shows four tabs with the investments module and three without", async () => {
  setLanguageForTests("en");
  const fixture = moneyStore();
  try {
    applyMoneyCommand(fixture.a, setModules, { moduleIds: ["budget", "assets", "investments"] });
    applyMoneyCommand(fixture.b, setModules, { moduleIds: ["budget", "assets", "loans"] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ServicesProvider services={fixture.services}>
        <StoreProvider client={fixture.client}>
          <ProfileProvider>{children}</ProfileProvider>
        </StoreProvider>
      </ServicesProvider>
    );
    await renderRouter(
      {
        "(tabs)/_layout": TabsLayout,
        "(tabs)/today/index": () => <Text>today root</Text>,
        "(tabs)/activity/index": () => <Text>activity root</Text>,
        "(tabs)/investments/index": () => <Text>investments root</Text>,
        "(tabs)/networth/index": () => <Text>networth root</Text>,
      },
      { initialUrl: "/today", wrapper },
    );
    expect(screen.getByText("today root")).toBeOnTheScreen();
    expect(tabTitles()).toEqual(["Today", "Activity", "Investments", "Net worth"]);
    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });
    expect(tabTitles()).toEqual(["Today", "Activity", "Net worth"]);
  } finally {
    fixture.close();
  }
});
