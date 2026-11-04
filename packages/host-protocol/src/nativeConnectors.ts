/** Replies of the owner UI's connector picker install (`native.connectors.v1`), read by Electron main. */
import { z } from "zod";

/** `native.connectors.prepareInstall`: the session-bound one-use install token. */
export const nativeConnectorsPrepareResultSchema = z.looseObject({ token: z.string() });

/** `native.connectors.commitInstall`: the installed connector's id and content digest. */
export const nativeConnectorsCommitResultSchema = z.looseObject({
  id: z.string(),
  digest: z.string(),
});
