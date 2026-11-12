import { EmptyState } from "@cashu/ui/native";
import { View } from "react-native";
import { S } from "../../../src/shell/Shell.strings";

export { ErrorBoundary } from "expo-router";

/** TRANSITIONAL(S42b): the investments screens (M2) replace this placeholder. */
export default function InvestmentsRoute() {
  return (
    <View className="flex-1 justify-center bg-surface">
      <EmptyState title={S.investmentsSoon} />
    </View>
  );
}
