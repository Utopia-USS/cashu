// `@cashu/domain/pyYaml`: the PyYAML port's public surface (compose, the event walk, `yaml.safe_load`
// and the Python value model). Package code inside the domain keeps importing `./index.js` directly.
export {
  composeYaml,
  walkYamlEvents,
  type YamlComposeResult,
  type YamlError,
  type YamlEvent,
  type YamlMark,
  type YamlNode,
} from "./index.js";
export {
  isPyMap,
  isPyNumber,
  PyDate,
  PyDateTime,
  type PyPlain,
  type PyPlainMap,
  pyStr,
} from "./plain.js";
export { plainMap, type SafeLoadResult, safeLoadYaml, toPlain } from "./plainTree.js";
