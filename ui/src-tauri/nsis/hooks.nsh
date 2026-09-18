; ui/src-tauri/nsis/hooks.nsh - TermX installer hooks (Tauri NSIS template).
;
; PRE-INSTALL: the terminal daemon and the output helper may be running. NSIS
; cannot overwrite a running exe, but Windows lets us rename it and the
; running process keeps its mapped image. The UI deletes *.old on launch
; (ui/src-tauri/src/cleanup.rs); a delete that fails because the old daemon
; still runs is retried next launch. Rename on a missing source is a no-op
; warning, which is what a first install produces.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe.old"
  Rename "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe" "$INSTDIR\termx-host-x86_64-pc-windows-msvc.exe.old"
  Delete "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe.old"
  Rename "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe" "$INSTDIR\termx-output-x86_64-pc-windows-msvc.exe.old"
!macroend

; POST-INSTALL: a silent run (/S) came from TermX's own updater, which exited
; before starting us; bring it back. A hand-run installer keeps the normal
; finish page.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${Silent}
    Exec '"$INSTDIR\TermX.exe"'
  ${EndIf}
!macroend
