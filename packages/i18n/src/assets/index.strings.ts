// Texts of the assets module definition (index.tsx) and its first steps page (Start.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  name: { pl: "Majątek", en: "Assets" },
  desc: {
    pl: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
    en: "Property, cars and other manually valued assets",
  },
  added: { pl: "Dodano", en: "Added" },
});
