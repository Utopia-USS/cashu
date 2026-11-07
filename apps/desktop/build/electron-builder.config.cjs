// The prod flavor's electron-builder config (cashU.app). Every flavor's config, including the
// staging one package-macos.mjs --flavor staging generates a wrapper for, comes from flavor-config.cjs.
module.exports = require("./flavor-config.cjs").builderConfig("prod");
