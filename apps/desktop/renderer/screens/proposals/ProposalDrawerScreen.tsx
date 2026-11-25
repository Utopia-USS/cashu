import { S } from "@cashu/i18n/core/ProposalDrawer.strings";
import { useProfile } from "@cashu/store-react";
import { Drawer, Notice, Skeleton, useUiEnv } from "@cashu/ui";
import { Component, type ReactNode, Suspense } from "react";
import { P } from "./ProposalDrawer.strings.js";
import { ProposalDrawerView } from "./ProposalDrawerView.js";
import { proposalDrawerModel } from "./proposalDrawerModel.js";
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
    <ProposalBoundary key={`${vault}:${privacy}:${gid}`} onClose={onClose}>
      <Suspense fallback={<DrawerStatus onClose={onClose} />}>
        <BoundProposal gid={gid} onClose={onClose} onOutcome={onOutcome} />
      </Suspense>
    </ProposalBoundary>
  );
}
function BoundProposal(props: Parameters<typeof ProposalDrawerScreen>[0]) {
  const state = useProposalDrawer(props.gid, props.onOutcome);
  return <ProposalDrawerView m={proposalDrawerModel(state)} onClose={props.onClose} />;
}
/** First load (old `<Skeleton h={160} />`) or a failed read (old `S.loadFailed`), inside the same drawer. */
function DrawerStatus({ onClose, error }: { onClose(): void; error?: string }) {
  return (
    <Drawer title={S.title} label={S.title} width={600} onClose={onClose}>
      {error ? <Notice tone="negative">{error}</Notice> : <Skeleton height={160} />}
    </Drawer>
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
      <DrawerStatus onClose={this.props.onClose} error={S.loadFailed(P.loadFailed)} />
    ) : (
      this.props.children
    );
  }
}
