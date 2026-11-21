// The mountable update card (contract-C.md): its own hook, no props. Mount once inside the profile shell.
import { UpdateNoticeView } from "./UpdateNoticeView.js";
import { useUpdateNotice } from "./useUpdateNotice.js";

export function UpdateNotice() {
  return <UpdateNoticeView state={useUpdateNotice()} />;
}
