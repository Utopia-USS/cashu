import { catalog } from "@cashu/i18n";

export const C = catalog({
  deviceAlias: { pl: "Nazwa tego urządzenia", en: "Name this device" },
  deviceAliasHint: {
    pl: "Opcjonalna nazwa, po której rozpoznasz ten komputer.",
    en: "An optional label to recognize this computer.",
  },
  unavailable: {
    pl: "Tworzenie profilu jest teraz niedostępne na tym urządzeniu.",
    en: "Profile creation is currently unavailable on this device.",
  },
  checking: { pl: "Sprawdzanie, czy można utworzyć profil…", en: "Checking profile creation…" },
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
  preparing: { pl: "Przygotowywanie frazy odzyskiwania…", en: "Preparing recovery…" },
  committing: { pl: "Tworzenie zaszyfrowanego profilu…", en: "Creating encrypted profile…" },
  pending: { pl: "Tworzenie profilu trwa.", en: "Profile creation is in progress." },
  unknown: {
    pl: "Nie wiadomo jeszcze, czy profil powstał. Sprawdź stan tworzenia tego profilu. Nie zaczynaj nowego.",
    en: "The result is not confirmed yet. Check this creation's status. Do not start a new profile.",
  },
  checkStatus: { pl: "Sprawdź stan", en: "Check status" },
  checkingStatus: { pl: "Sprawdzanie stanu…", en: "Checking status…" },
  restartPossible: {
    pl: "Aplikacja potwierdziła, że tworzenie profilu się nie rozpoczęło. Możesz zacząć od nowa.",
    en: "The host confirmed no creation was started. You can start again.",
  },
  restart: { pl: "Rozpocznij ponownie", en: "Start again" },
  expired: {
    pl: "Przygotowanie wygasło. Sprawdź stan, zanim zaczniesz od nowa.",
    en: "Preparation expired. Check status before starting again.",
  },
  refused: { pl: "Nie można teraz utworzyć profilu.", en: "The profile cannot be created now." },
  verifying: {
    pl: "Sprawdzanie nowego profilu po ponownym połączeniu…",
    en: "Checking the new profile after reconnecting…",
  },
  ready: { pl: "Profil jest gotowy.", en: "Your profile is ready." },
  workspaceUnavailable: {
    pl: "W tym kroku nie można utworzyć workspace.",
    en: "Creating the workspace in this step is unavailable.",
  },
  workspaceDefault: { pl: "Domyślny folder", en: "Default folder" },
  workspaceChecking: { pl: "Sprawdzanie workspace…", en: "Checking workspace…" },
  workspaceApply: { pl: "Utwórz workspace", en: "Create workspace" },
  workspaceFailed: {
    pl: "Profil jest gotowy, ale workspace nie został ukończony.",
    en: "Your profile is ready, but the workspace was not completed.",
  },
  workspaceUnknown: {
    pl: "Nie wiadomo, czy workspace został utworzony. Sprawdź, zanim spróbujesz ponownie.",
    en: "The workspace result is uncertain. Check its status before trying again.",
  },
  workspaceRetry: { pl: "Utwórz ponownie sam workspace", en: "Retry workspace only" },
  workspaceSkip: { pl: "Pomiń workspace", en: "Skip workspace" },
  workspaceCheck: { pl: "Sprawdź workspace", en: "Check workspace" },
  stageRecorded: { pl: "Rozpoczęto tworzenie", en: "Creation recorded" },
  stageKeys: { pl: "Zabezpieczanie kluczy", en: "Securing keys" },
  stageArtifacts: { pl: "Zapisywanie plików", en: "Writing files" },
  stageHistory: { pl: "Zapisywanie historii", en: "Writing history" },
  stageAdmission: { pl: "Sprawdzanie uprawnień", en: "Checking authority" },
  stagePublishing: { pl: "Otwieranie profilu", en: "Opening profile" },
});
