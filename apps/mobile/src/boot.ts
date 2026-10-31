// Runs before Expo Router loads any route (index.ts imports it first).
import { installMobileLanguage } from "./platform/language";
import { installWebCryptoRandom } from "./platform/webCrypto";

/** Wall clock when the JS bundle started (the S41 startup log compares it with the first data frame). */
export const bootStartedAt = Date.now();

installWebCryptoRandom();
installMobileLanguage();
