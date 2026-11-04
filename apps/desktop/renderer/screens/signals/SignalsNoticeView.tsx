import { noticeLabel, refusalLabel } from "./labels.js";
import type { SignalsNotice } from "./outcomes.js";

/** The outcome of the last owner write: a status line and, when refused, the reason. */
export function SignalsNoticeView({
  notice,
  refusal,
}: {
  notice: SignalsNotice | null;
  refusal: string | null;
}) {
  return (
    <>
      {notice && <p role="status">{noticeLabel(notice)}</p>}
      {refusal && <p role="alert">{refusalLabel(refusal)}</p>}
    </>
  );
}
