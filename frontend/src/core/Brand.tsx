// Brand in the shell header (design v2 F-16): the cashU "U" mark on an ink square + the wordmark.
// The mark is always on black (1 px 8 % white edge in dark), never on a colour; minimum 16 px.
import mark from "../assets/logo-mark.png";

export function Brand() {
  return (
    <>
      <span className="mark" aria-hidden><img src={mark} alt="" width={22} height={22} /></span>
      <h1 className="wordmark">cashU</h1>
    </>
  );
}
