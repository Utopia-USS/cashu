import { SpendingView } from "../src/screens/spending/SpendingView";
import { useSpendingScreen } from "../src/screens/spending/useSpendingScreen";

export { ErrorBoundary } from "expo-router";

export default function SpendingRoute() {
  return <SpendingView {...useSpendingScreen()} />;
}
