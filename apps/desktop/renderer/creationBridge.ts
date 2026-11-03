import type {
  NativeCreationCommitParams,
  NativeCreationCommitResult,
  NativeCreationCurrentResult,
  NativeCreationInspectParams,
  NativeCreationInspectResult,
  NativeCreationPrepareParams,
  NativeCreationPrepareResult,
} from "@cashu/host-protocol";

/** Narrow renderer access to the host-owned native enrollment capability. */
export interface CreationBridge {
  prepare(input: NativeCreationPrepareParams): Promise<NativeCreationPrepareResult>;
  commit(input: NativeCreationCommitParams): Promise<NativeCreationCommitResult>;
  inspect(input: NativeCreationInspectParams): Promise<NativeCreationInspectResult>;
  current(): Promise<NativeCreationCurrentResult>;
}

/** Preload exposes only these four checked methods for this frame's own origin. */
export function creationBridge(): CreationBridge | null {
  return (window as Window & { readonly cashuCreation?: CreationBridge }).cashuCreation ?? null;
}
