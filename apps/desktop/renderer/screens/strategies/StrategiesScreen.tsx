import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { StrategiesView } from "./StrategiesView.js";
import { useStrategiesScreen } from "./useStrategiesScreen.js";
export function StrategiesScreen({
  onProposalOpened,
}: {
  onProposalOpened?: (gid: string) => void;
}) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return <BoundStrategies key={`${vault}:${privacy}`} onProposalOpened={onProposalOpened} />;
}
function BoundStrategies({ onProposalOpened }: { onProposalOpened?: (gid: string) => void }) {
  return <StrategiesView state={useStrategiesScreen(onProposalOpened)} />;
}
