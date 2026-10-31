// Runs before Expo Router loads any route (index.ts imports it first).
import { installMobileLanguage } from "./platform/language";

installMobileLanguage();
