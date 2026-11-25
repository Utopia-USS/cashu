import { BenchView } from "../src/screens/bench/BenchView";
import { useBenchScreen } from "../src/screens/bench/useBenchScreen";

export { ErrorBoundary } from "expo-router";

export default function BenchRoute() {
  return <BenchView {...useBenchScreen()} />;
}
