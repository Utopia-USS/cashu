// Stories of the tab header (CSF 3, synthetic profiles): owner, partner, incognito, a stale and a missing
// freshness line, an extra action. The shell smoke test renders every story.
import { Text } from "react-native";
import { TabHeader, type TabHeaderProps } from "./TabHeader";

const base: TabHeaderProps = {
  profile: { initial: "A", name: "Anna" },
  title: "November",
  fresh: { tone: "ok", text: "Bank data from 06:40" },
  offline: null,
  incognito: false,
  onProfilePress: () => {},
  onIncognitoToggle: () => {},
};

const meta = { title: "Mobile/Shell/TabHeader", component: TabHeader, args: base };
export default meta;

export const Owner = { args: {} };
export const Partner = {
  args: { profile: { initial: "H", name: "Home" }, title: "Net worth" },
};
export const Incognito = { args: { incognito: true } };
export const StaleBankData = {
  args: { fresh: { tone: "warn", text: "Bank data from Mon 07:30 · 3 days old" } },
};
export const NoFreshness = { args: { fresh: null, title: "Activity" } };
export const WithAction = {
  args: { title: "Activity", right: <Text className="text-body text-accent">Cash</Text> },
};
export const Offline = { args: { offline: "2 changes waiting" } };
