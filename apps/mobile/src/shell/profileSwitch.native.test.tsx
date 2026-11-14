// A profile switch starts the other profile fresh (S19): the actual `(tabs)` layout under expo-router's
// test router over the real store, a tab stack with a pushed page and a tab root holding its own local
// state (as the Portfolio's account filter). After the switch the other profile opens on its tab root
// with no pushed page of the previous profile and no state carried over.
import { setLanguageForTests } from "@cashu/i18n";
import { setCurrentVault } from "@cashu/store/device";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { router, Stack } from "expo-router";
import { act, fireEvent, renderRouter, screen } from "expo-router/testing-library";
import { type ReactNode, useState } from "react";
import { Pressable, Text } from "react-native";
import TabsLayout from "../../app/(tabs)/_layout";
import { MONEY_VAULT_A, MONEY_VAULT_B, moneyStore } from "../screens/testing/moneyStore";
import { ServicesProvider } from "../services/ServicesProvider";

/** A tab root with screen-local state, as the Portfolio's account filter. */
function TodayRoot() {
  const [filter, setFilter] = useState<string | null>(null);
  const vault = useProfile();
  return (
    <>
      <Text>{`today root of ${vault === MONEY_VAULT_A ? "A" : "B"}`}</Text>
      <Text>{`filter ${filter ?? "none"}`}</Text>
      <Pressable accessibilityRole="button" onPress={() => setFilter("account-1")}>
        <Text>set filter</Text>
      </Pressable>
    </>
  );
}

it("opens the other profile on its tab root, with no pushed page and no local state of the previous one", async () => {
  setLanguageForTests("en");
  const fixture = moneyStore();
  try {
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
        "(tabs)/today/_layout": () => <Stack />,
        "(tabs)/today/index": TodayRoot,
        "(tabs)/today/spending": () => <Text>spending page</Text>,
        "(tabs)/activity/index": () => <Text>activity root</Text>,
        "(tabs)/investments/index": () => <Text>investments root</Text>,
        "(tabs)/networth/index": () => <Text>networth root</Text>,
      },
      { initialUrl: "/today", wrapper },
    );
    expect(screen.getByText("today root of A")).toBeOnTheScreen();
    await act(async () => fireEvent.press(screen.getByText("set filter")));
    expect(screen.getByText("filter account-1")).toBeOnTheScreen();
    await act(() => router.push("/today/spending"));
    expect(screen).toHavePathname("/today/spending");
    expect(screen.getByText("spending page")).toBeOnTheScreen();

    await act(() => {
      fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    });

    expect(screen).toHavePathname("/today");
    expect(screen.queryByText("spending page")).toBeNull();
    expect(screen.getByText("today root of B")).toBeOnTheScreen();
    expect(screen.getByText("filter none")).toBeOnTheScreen();
  } finally {
    fixture.close();
  }
});
