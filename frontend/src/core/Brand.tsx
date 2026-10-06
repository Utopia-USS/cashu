// Brand in the shell header: the long cashU logo (wordmark + cashew "U") on a transparent background.
// Two cuts: ink letters for the light theme, cream letters for the dark one (switched in CSS).
import logoDark from "../assets/logo-wordmark.png";
import logoLight from "../assets/logo-wordmark-light.png";

export function Brand() {
  return (
    <h1 className="logo">
      <img className="on-light" src={logoLight} alt="cashU" width={82} height={26} />
      <img className="on-dark" src={logoDark} alt="" aria-hidden width={82} height={26} />
    </h1>
  );
}
