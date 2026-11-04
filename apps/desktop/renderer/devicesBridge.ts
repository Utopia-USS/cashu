import type {
  DeviceListParams,
  DeviceListResult,
  LeaderCommitParams,
  LeaderCommitResult,
  LeaderInspectParams,
  LeaderInspectResult,
  LeaderPreviewParams,
  LeaderPreviewResult,
  RevokeCancelParams,
  RevokeCancelResult,
  RevokeCommitParams,
  RevokeCommitResult,
  RevokeInspectParams,
  RevokeInspectResult,
  RevokePreviewParams,
  RevokePreviewResult,
} from "@cashu/host-protocol";

export interface DevicesBridge {
  list(input: DeviceListParams): Promise<DeviceListResult>;
  revokePreview(input: RevokePreviewParams): Promise<RevokePreviewResult>;
  revokeCommit(input: RevokeCommitParams): Promise<RevokeCommitResult>;
  revokeInspect(input: RevokeInspectParams): Promise<RevokeInspectResult>;
  revokeCancel(input: RevokeCancelParams): Promise<RevokeCancelResult>;
  leaderPreview(input: LeaderPreviewParams): Promise<LeaderPreviewResult>;
  leaderCommit(input: LeaderCommitParams): Promise<LeaderCommitResult>;
  leaderInspect(input: LeaderInspectParams): Promise<LeaderInspectResult>;
}

export function devicesBridge(): DevicesBridge | null {
  return (window as Window & { readonly cashuDevices?: DevicesBridge }).cashuDevices ?? null;
}
