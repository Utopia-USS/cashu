// Mountable investments drawers (ab24ab6 modules/investments/Drawers.tsx): each one is mounted while it is open
// (state starts from its props), the owner (the Home screen) keeps which drawer is open and toasts after a save.
import { Suspense } from "react";
import {
  AccountDrawerView,
  ThesisDrawerView,
  TxnDrawerView,
  TxnsDrawerView,
} from "./InvestmentDrawersView.js";
import {
  type AccountDrawerInput,
  type ThesisDrawerInput,
  type TxnDrawerInput,
  type TxnsDrawerInput,
  useAccountDrawer,
  useThesisDrawer,
  useTxnDrawer,
  useTxnsDrawer,
} from "./useInvestmentDrawers.js";

export function TxnDrawer(props: TxnDrawerInput) {
  return <TxnDrawerView state={useTxnDrawer(props)} />;
}

export function AccountDrawer(props: AccountDrawerInput) {
  return <AccountDrawerView state={useAccountDrawer(props)} />;
}

export function ThesisDrawer(props: ThesisDrawerInput) {
  return <ThesisDrawerView state={useThesisDrawer(props)} />;
}

function TxnsBound(props: TxnsDrawerInput) {
  return <TxnsDrawerView state={useTxnsDrawer(props)} />;
}

/** The ledger read suspends on first load: the drawer shows its skeleton meanwhile (old `<Skeleton h={120} />`). */
export function TxnsDrawer(props: TxnsDrawerInput) {
  return (
    <Suspense
      fallback={
        <TxnsDrawerView
          state={{
            tag: props.position.instrument.label,
            error: null,
            rows: null,
            onClose: props.onClose,
            onAdd: props.onAdd,
          }}
        />
      }
    >
      <TxnsBound {...props} />
    </Suspense>
  );
}
