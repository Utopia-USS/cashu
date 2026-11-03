import { MoneyView } from "../src/screens/money/MoneyView";
import { useMoneyScreen } from "../src/screens/money/useMoneyScreen";

export { ErrorBoundary } from "expo-router";

export default function MoneyRoute() {
  return <MoneyView {...useMoneyScreen()} />;
}
