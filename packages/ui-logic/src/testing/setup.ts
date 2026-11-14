import { setLanguageForTests } from "@cashu/i18n";

// Preserve the original pure-helper suites' Polish baseline before module-level formatters load.
setLanguageForTests("pl");
