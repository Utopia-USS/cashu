import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import { render, screen } from "@testing-library/react-native";
import meta, {
  Empty,
  ExactLargeValue,
  ManyCategories,
  MultipleCategories,
} from "./SpendingView.stories";

jest.mock("@expo/ui", () => require("../testing/expoUiMock"));

beforeEach(() => setLanguageForTests("en"));

it.each(Object.entries({ MultipleCategories, ExactLargeValue, Empty, ManyCategories }))(
  "%s story renders its spending meaning",
  async (_name, story) => {
    await render(<meta.component {...story.args} />);
    expect(screen.getByRole("heading", { name: "Spending by category" })).toBeOnTheScreen();
  },
);

it("keeps exact amounts out of visible and accessible text in privacy mode", async () => {
  await render(
    <UiEnvProvider privacy locale="en-US">
      <meta.component {...ExactLargeValue.args} />
    </UiEnvProvider>,
  );
  expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(0);
  const hidden = JSON.stringify(screen.toJSON());
  expect(hidden).not.toContain("9007199254740993");
  expect(hidden).not.toContain("9,007,199,254,740,993");
  expect(screen.getByLabelText(/Other 100%/)).toBeOnTheScreen();
});

it("explains the empty state without a fake spending chart", async () => {
  await render(<meta.component {...Empty.args} />);
  expect(screen.getByText("No spending")).toBeOnTheScreen();
  expect(screen.queryByRole("image")).toBeNull();
});
