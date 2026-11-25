; The uninstall step of the Windows installer that electron-builder's own NSIS templates lack
; (flavor-config.cjs `nsis.include`; package-windows.mjs builds prod only, so the scheme is prod's).
;
; The packaged app registers the `cashu://` scheme for the current user at every start
; (apps/desktop/src/deeplink.ts): HKCU\Software\Classes\cashu with Electron's default command
; `"<cashU.exe>" "%1"`. A full uninstall removes that key, and only when its command still opens
; this install's cashU.exe: a key another install (or another app) owns now stays. An update runs
; the old uninstaller with --updated: the key stays, as the new version's cashU.exe at the same
; path keeps it. Nothing here touches files: the install folder gains nothing (the installed tree is
; the package plus the uninstaller, verify-package-windows.mjs --installed-from) and the data dir
; (%LOCALAPPDATA%\cashU) is never touched.
;
; The file name is not one electron-builder discovers by itself in apps/desktop/build (installer.nsh):
; it reaches the script only through the explicit include.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R0
    ClearErrors
    ReadRegStr $R0 HKCU "Software\Classes\cashu\shell\open\command" ""
    ${ifNot} ${Errors}
      ; LogicLib `==` compares without case, as Windows paths do.
      ${if} $R0 == `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"`
        DeleteRegKey HKCU "Software\Classes\cashu"
      ${endIf}
    ${endIf}
    Pop $R0
  ${endIf}
!macroend
