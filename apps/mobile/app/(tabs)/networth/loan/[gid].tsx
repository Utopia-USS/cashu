// A loan's page, pushed from the Net worth tab's loans tile; the native header names the loan.
import { Stack, useLocalSearchParams } from "expo-router";
import { S } from "../../../../src/screens/loan/Loan.strings";
import { LoanView } from "../../../../src/screens/loan/LoanView";
import { useLoanScreen } from "../../../../src/screens/loan/useLoanScreen";
import { useNow } from "../../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function LoanRoute() {
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today } = useNow();
  const props = useLoanScreen({ gid, today });
  return (
    <>
      <Stack.Screen options={{ title: props.loan?.name ?? S.loan }} />
      <LoanView {...props} />
    </>
  );
}
