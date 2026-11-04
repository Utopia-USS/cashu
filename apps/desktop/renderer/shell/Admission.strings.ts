import { catalog } from "@cashu/i18n";

export const S = catalog({
  title: { pl: "Dane wymagają sprawdzenia", en: "Your data needs review" },
  migrationRequired: {
    pl: "Wykryto dane z poprzedniej wersji. Otwieranie ich w tej wersji będzie dostępne po bezpiecznej migracji.",
    en: "Data from the previous version was found. Opening it here requires a safe migration.",
  },
  refused: {
    pl: "Nie można bezpiecznie otworzyć tych danych. Sprawdź instalację przed ponowną próbą.",
    en: "This data cannot be opened safely. Check the installation before trying again.",
  },
  retry: { pl: "Sprawdź ponownie", en: "Check again" },
});
