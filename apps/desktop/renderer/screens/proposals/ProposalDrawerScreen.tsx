import { useProfile } from "@cashu/store-react";
import { Modal, useUiEnv } from "@cashu/ui";
import { Component, type ReactNode, Suspense } from "react";
import { P } from "./ProposalDrawer.strings.js";
import { ProposalDrawerView } from "./ProposalDrawerView.js";
import { useProposalDrawer } from "./useProposalDrawer.js";

export function ProposalDrawerScreen({
  gid,
  onClose,
  onOutcome,
}: {
  gid: string;
  onClose(): void;
  onOutcome?(outcome: {
    proposalGid: string;
    status: string;
    version?: number;
    approvalEid?: string;
    recoveryReason?: string;
  }): void;
}) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <Modal label={P.title} onClose={onClose} placement="end">
      <ProposalBoundary key={`${vault}:${privacy}:${gid}`} onClose={onClose}>
        <Suspense fallback={<DrawerStatus onClose={onClose} text={P.loading} />}>
          <BoundProposal gid={gid} onClose={onClose} onOutcome={onOutcome} />
        </Suspense>
      </ProposalBoundary>
    </Modal>
  );
}
function BoundProposal(props: Parameters<typeof ProposalDrawerScreen>[0]) {
  const state = useProposalDrawer(props.gid, props.onOutcome);
  return <ProposalDrawerView state={state} onClose={props.onClose} />;
}
function DrawerStatus({ onClose, text }: { onClose(): void; text: string }) {
  return (
    <>
      <button type="button" onClick={onClose} aria-label={P.close}>
        {P.close}
      </button>
      <p role="status" className="mt-6">
        {text}
      </p>
    </>
  );
}
class ProposalBoundary extends Component<
  { children: ReactNode; onClose(): void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <DrawerStatus onClose={this.props.onClose} text={P.loadFailed} />
    ) : (
      this.props.children
    );
  }
}
