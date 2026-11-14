// The profile sheet's "Waiting for you on the Mac" section (M3 acceptance note 2): shown only while
// something waits; with nothing waiting the whole section is gone and the quiet line about the Mac stays.
import { setLanguageForTests } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui/native";
import { render, screen } from "@testing-library/react-native";
import { ProfileSheetView } from "./ProfileSheetView";
import meta, { ProposalsWaiting } from "./ProfileSheetView.stories";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

beforeEach(() => setLanguageForTests("en"));

const MAC_ONLY =
  "Everything that builds or changes the setup - imports, approvals, rules, strategy - stays on the Mac.";

it("hides the whole section when nothing waits, and keeps the line about the Mac", async () => {
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <ProfileSheetView {...meta.args} />
    </UiEnvProvider>,
  );
  expect(screen.queryByText("Waiting for you on the Mac")).toBeNull();
  expect(screen.queryByText("Nothing waiting")).toBeNull();
  expect(screen.getByText(MAC_ONLY)).toBeOnTheScreen();
});

it("shows the section with the suggestions waiting", async () => {
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <ProfileSheetView
        {...meta.args}
        waiting={{ kind: "proposals", count: ProposalsWaiting.args.waiting.count }}
      />
    </UiEnvProvider>,
  );
  expect(screen.getByText("Waiting for you on the Mac")).toBeOnTheScreen();
  expect(screen.getByText("2 suggestions to approve")).toBeOnTheScreen();
  expect(screen.getByText(MAC_ONLY)).toBeOnTheScreen();
});
