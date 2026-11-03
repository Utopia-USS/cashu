import { catalog } from "@cashu/i18n";

export const C = catalog({
  deviceAlias: { pl: "Nazwa tego urządzenia", en: "Name this device" },
  deviceAliasHint: {
    pl: "Opcjonalna nazwa rozpoznawcza dla tego komputera.",
    en: "An optional label to recognize this computer.",
  },
  unavailable: {
    pl: "Tworzenie profilu jest teraz niedostępne na tym urządzeniu.",
    en: "Profile creation is currently unavailable on this device.",
  },
  checking: { pl: "Sprawdzanie tworzenia profilu…", en: "Checking profile creation…" },
  recoveryTitle: { pl: "Zapisz frazę odzyskiwania", en: "Save your recovery phrase" },
  recoveryHint: {
    pl: "Zapisz te słowa poza komputerem, w bezpiecznym miejscu. Nie udostępniaj ich nikomu. Po zamknięciu tego kroku nie pokażemy ich ponownie.",
    en: "Write these words down somewhere safe outside this computer. Do not share them. They will not be shown again after this step closes.",
  },
  backupConfirmed: {
    pl: "Zapisałem lub zapisałam frazę i mogę ją odzyskać.",
    en: "I saved the phrase and can retrieve it.",
  },
  commit: { pl: "Utwórz bezpieczny profil", en: "Create secure profile" },
  preparing: { pl: "Przygotowywanie odzyskiwania…", en: "Preparing recovery…" },
  committing: { pl: "Tworzenie zaszyfrowanego profilu…", en: "Creating encrypted profile…" },
  pending: { pl: "Tworzenie profilu trwa.", en: "Profile creation is in progress." },
  unknown: {
    pl: "Nie możemy jeszcze potwierdzić wyniku. Sprawdź stan tego samego tworzenia. Nie zaczynaj nowego profilu.",
    en: "The result is not confirmed yet. Check this creation's status. Do not start a new profile.",
  },
  checkStatus: { pl: "Sprawdź stan", en: "Check status" },
  checkingStatus: { pl: "Sprawdzanie stanu…", en: "Checking status…" },
  restartPossible: {
    pl: "Host potwierdził brak rozpoczętego tworzenia. Możesz rozpocząć ponownie.",
    en: "The host confirmed no creation was started. You can start again.",
  },
  restart: { pl: "Rozpocznij ponownie", en: "Start again" },
  expired: {
    pl: "Przygotowanie wygasło. Sprawdź stan przed ponownym rozpoczęciem.",
    en: "Preparation expired. Check status before starting again.",
  },
  refused: { pl: "Nie można teraz utworzyć profilu.", en: "The profile cannot be created now." },
  verifying: {
    pl: "Sprawdzanie nowego profilu po ponownym połączeniu…",
    en: "Checking the new profile after reconnecting…",
  },
  ready: { pl: "Profil jest gotowy.", en: "Your profile is ready." },
  workspaceLater: {
    pl: "Tworzenie workspace agenta jest obecnie niedostępne.",
    en: "Creating an agent workspace is currently unavailable.",
  },
  workspaceUnavailable: {
    pl: "Tworzenie workspace w tym kroku jest niedostępne.",
    en: "Creating the workspace in this step is unavailable.",
  },
  stageRecorded: { pl: "Zapisano rozpoczęcie", en: "Creation recorded" },
  stageKeys: { pl: "Zabezpieczanie kluczy", en: "Securing keys" },
  stageArtifacts: { pl: "Zapisywanie plików", en: "Writing files" },
  stageHistory: { pl: "Zapisywanie historii", en: "Writing history" },
  stageAdmission: { pl: "Sprawdzanie uprawnień", en: "Checking authority" },
  stagePublishing: { pl: "Otwieranie profilu", en: "Opening profile" },
});
