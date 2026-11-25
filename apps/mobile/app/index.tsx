import { Redirect } from "expo-router";

export { ErrorBoundary } from "expo-router";

export default function HomeRoute() {
  return <Redirect href="/(tabs)/today" />;
}
