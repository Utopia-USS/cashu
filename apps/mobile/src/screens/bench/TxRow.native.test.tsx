import { D, Money as MoneyValue } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { render, screen } from "@testing-library/react-native";
import { type TxItem, TxRow } from "./TxRow";

const item: TxItem = {
  id: 1,
  title: "Synthetic merchant",
  date: "2026-10-01",
  category: "groceries",
  amount: new MoneyValue(D("-9007199254740993.12"), "USD"),
  negative: true,
};

it("renders raw row values through the shared locale/privacy components", async () => {
  const node = (locale: string, privacy: boolean) => (
    <UiEnvProvider locale={locale} privacy={privacy}>
      <TxRow item={item} />
    </UiEnvProvider>
  );
  const view = await render(node("en-US", false));
  expect(screen.getByText("-$9,007,199,254,740,993.12")).toBeOnTheScreen();
  expect(screen.getByText("Oct 1, 2026")).toBeOnTheScreen();
  await view.rerender(node("pl-PL", true));
  expect(screen.getByLabelText("Kwota ukryta")).toBeOnTheScreen();
  expect(JSON.stringify(screen.toJSON())).not.toContain("9007199");
  expect(screen.queryByText(/9,007/)).toBeNull();
});
