import type {
  PairingCancelParams,
  PairingCancelResult,
  PairingConfirmParams,
  PairingConfirmResult,
  PairingInspectParams,
  PairingInspectResult,
  PairingInviteParams,
  PairingInviteResult,
} from "@cashu/host-protocol";

export interface PairingBridge {
  invite(input: PairingInviteParams): Promise<PairingInviteResult>;
  confirm(input: PairingConfirmParams): Promise<PairingConfirmResult>;
  inspect(input: PairingInspectParams): Promise<PairingInspectResult>;
  cancel(input: PairingCancelParams): Promise<PairingCancelResult>;
}

export function pairingBridge(): PairingBridge | null {
  return (window as Window & { readonly cashuPairing?: PairingBridge }).cashuPairing ?? null;
}
