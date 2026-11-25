// The pinned sheet and modal routes (cash, payment, alert, triage, review) render their subtree under the
// vault they were opened with (`PinnedProfile`): even when the route's guard let a render through after
// the current profile moved on, everything below it reads the pinned vault, never the current one.
// Real route files under expo-router's test router; the screen hooks and Views are stand-ins that show
// which vault the subtree sees.
import { setCurrentVault } from "@cashu/store/device";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { renderRouter, screen } from "expo-router/testing-library";
import type { ReactNode } from "react";
import { Text } from "react-native";
import ReviewRoute from "../../../app/modal/review";
import TriageRoute from "../../../app/modal/triage";
import AlertSheetRoute from "../../../app/sheet/alert/[gid]";
import CashSheetRoute from "../../../app/sheet/cash";
import PaymentSheetRoute from "../../../app/sheet/payment/[gid]";
import { ServicesProvider } from "../../services/ServicesProvider";
import { MONEY_VAULT_A, MONEY_VAULT_B, moneyStore } from "../testing/moneyStore";

/** A guard that failed: the route stays pinned to A although the current profile is B. */
jest.mock("./switchProfile", () => ({
  usePinnedVault: () => require("../testing/moneyStore").MONEY_VAULT_A,
}));
jest.mock("../../shell/useNow", () => ({
  useNow: () => ({ today: "2026-11-12", now: "2026-11-12T08:40:00.000Z" }),
}));
/** Every View shows the vault its subtree reads; every screen hook is a stand-in. */
const probe = () => {
  const { Text } = require("react-native");
  const { useProfile } = require("@cashu/store-react");
  const { createElement } = require("react");
  return () => createElement(Text, null, `reads ${useProfile()}`);
};
jest.mock("../cash/CashSheetView", () => ({ CashSheetView: probe() }));
jest.mock("../cash/useCashSheet", () => ({ useCashSheet: () => ({}) }));
jest.mock("../payment/PaymentSheetView", () => ({ PaymentSheetView: probe() }));
jest.mock("../payment/usePaymentSheet", () => ({ usePaymentSheet: () => ({}) }));
jest.mock("../alert/AlertSheetView", () => ({ AlertSheetView: probe() }));
jest.mock("../alert/useAlertSheet", () => ({ useAlertSheet: () => ({}) }));
jest.mock("../triage/TriageView", () => ({ TriageView: probe() }));
jest.mock("../triage/useTriageScreen", () => ({ useTriageScreen: () => ({}) }));
jest.mock("../review/ReviewDeckView", () => ({ ReviewDeckView: probe() }));
jest.mock("../review/useReviewDeck", () => ({ useReviewDeck: () => ({}) }));

const routes: [string, () => ReactNode][] = [
  ["sheet/cash", CashSheetRoute],
  ["sheet/payment/[gid]", PaymentSheetRoute],
  ["sheet/alert/[gid]", AlertSheetRoute],
  ["modal/triage", TriageRoute],
  ["modal/review", ReviewRoute],
];

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

it.each(routes)(
  "the %s route's subtree reads the vault it was opened with, not the current one",
  async (name, Route) => {
    const fixture = moneyStore();
    closers.push(() => fixture.close());
    fixture.device.run(setCurrentVault, { vault: MONEY_VAULT_B });
    await renderRouter(
      { index: () => <Text>start</Text>, [name]: Route },
      {
        initialUrl: `/${name.replace("[gid]", "g1")}`,
        wrapper: ({ children }: { children: ReactNode }) => (
          <ServicesProvider services={fixture.services}>
            <StoreProvider client={fixture.client}>
              <ProfileProvider>{children}</ProfileProvider>
            </StoreProvider>
          </ServicesProvider>
        ),
      },
    );
    expect(screen.getByText(`reads ${MONEY_VAULT_A}`)).toBeOnTheScreen();
  },
);
