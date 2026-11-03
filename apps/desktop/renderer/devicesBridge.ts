import type {
  DeviceListParams,
  DeviceListResult,
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
}

export function devicesBridge(): DevicesBridge | null {
  return (window as Window & { readonly cashuDevices?: DevicesBridge }).cashuDevices ?? null;
}
