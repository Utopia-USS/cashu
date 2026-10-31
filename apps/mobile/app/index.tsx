import { Suspense } from "react";
import { DebugView } from "../src/screens/debug/DebugView";
import { useDebugScreen } from "../src/screens/debug/useDebugScreen";

export { ErrorBoundary } from "expo-router";

function DebugScreen() {
  return <DebugView {...useDebugScreen()} />;
}

export default function DebugRoute() {
  return (
    <Suspense>
      <DebugScreen />
    </Suspense>
  );
}
