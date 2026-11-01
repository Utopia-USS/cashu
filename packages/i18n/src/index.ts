// @cashu/i18n: the UI language, text catalogs and plurals (docs/agents/localization.md). Platform free:
// no DOM, React or Node; the app installs a `LanguageSource` at startup. Screen copy catalogs live under
// src/<core|module>/ and are imported by their own subpath (`@cashu/i18n/core/common.strings`).
export { catalog } from "./catalog.js";
export {
  FALLBACK_LANG,
  inEveryLang,
  installLanguageSource,
  intlLocale,
  LANG_NAME,
  LANGS,
  type Lang,
  type LanguageSource,
  lang,
  matchLang,
  pinnedLang,
  setLanguage,
  setLanguageForTests,
} from "./lang.js";
export { normalizeNumberInput } from "./number.js";
export { enCount, enForm, plCount, plForm } from "./plural.js";
export {
  type BackendI18n,
  type BackendLanguageSource,
  createBackendI18n,
  createTranslator,
  LANG_ENV,
  LANG_HEADER,
  parseLang,
  type TranslationVariants,
  type Translator,
  tr,
} from "./tr.js";
