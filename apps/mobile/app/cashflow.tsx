import { CashflowView } from "../src/screens/cashflow/CashflowView";
import { useCashflowScreen } from "../src/screens/cashflow/useCashflowScreen";

export { ErrorBoundary } from "expo-router";

export default function CashflowRoute() {
  return <CashflowView {...useCashflowScreen()} />;
}
