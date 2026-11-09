import { catalog } from "@cashu/i18n";

export const T = catalog({
  title: { pl: "Klasyfikacja wydatków", en: "Expense classification" },
  local: { pl: "Lokalnie przez Ollama", en: "Locally with Ollama" },
  cloud: { pl: "Anthropic (chmura)", en: "Anthropic (cloud)" },
  localDetail: {
    pl: "Domyślnie nazwy i opisy transakcji pozostają na tym urządzeniu.",
    en: "By default, transaction names and descriptions stay on this device.",
  },
  risk: {
    pl: "Do Anthropic trafiają tylko nazwy sprzedawców. Nazwa może mimo filtrów zawierać dane osobowe, na przykład nazwisko osoby prowadzącej działalność. Anthropic przetwarza te nazwy poza tym urządzeniem.",
    en: "Only merchant names are sent to Anthropic. Despite filtering, a name may contain personal data, such as a sole trader's surname. Anthropic processes these names outside this device.",
  },
  consent: {
    pl: "Rozumiem to ryzyko i zgadzam się wysyłać kwalifikujące się nazwy sprzedawców do Anthropic dla tego profilu.",
    en: "I understand this risk and agree to send eligible merchant names to Anthropic for this profile.",
  },
  enable: { pl: "Włącz klasyfikację w chmurze", en: "Enable cloud classification" },
  revoke: { pl: "Cofnij zgodę i używaj Ollama", en: "Revoke consent and use Ollama" },
  key: { pl: "Klucz API Anthropic", en: "Anthropic API key" },
  keyStored: {
    pl: "Klucz zapisany w systemowym magazynie",
    en: "Key saved in OS credential store",
  },
  keyMissing: { pl: "Brak zapisanego klucza", en: "No saved key" },
  keyChange: {
    pl: "Zmiana lub usunięcie klucza wyłącza chmurę i cofa zgodę. Aby znów jej używać, zaakceptuj ryzyko ponownie.",
    en: "Changing or removing the key turns off cloud classification and revokes consent. Accept the risk again to use it.",
  },
  saveKey: { pl: "Zapisz klucz", en: "Save key" },
  clearKey: { pl: "Usuń klucz", en: "Remove key" },
  model: { pl: "Model", en: "Model" },
  unavailable: { pl: "Klasyfikacja jest niedostępna.", en: "Classification is unavailable." },
  unknown: {
    pl: "Wynik zmiany jest niepewny. Zanim wprowadzisz kolejną, poczekaj, aż stan poniżej się zaktualizuje.",
    en: "The change outcome is uncertain. Wait for the state below to update before another change.",
  },
  failed: { pl: "Nie udało się zmienić ustawień.", en: "Could not change settings." },
});
