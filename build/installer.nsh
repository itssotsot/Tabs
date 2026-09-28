; Included by electron-builder's NSIS installer (nsis.include in electron-builder.yml).

; Before installing, the installer runs the installed version's uninstaller. When that fails (a damaged
; "Uninstall Tabs.exe" fails its integrity check, for one), the default gives up with "uninstallFailed", so
; neither reinstalling nor background updates could ever replace it. Installing over the old files is safe:
; carry on, and the new install writes a working uninstaller.
!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint `The old version's uninstaller failed (code $R0). Installing over it.`
  ${endif}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend
