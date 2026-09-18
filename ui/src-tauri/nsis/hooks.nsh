; ui/src-tauri/nsis/hooks.nsh - TermX installer hooks (Tauri NSIS template).
;
; PRE-INSTALL: the terminal daemon and the output helper may be running. Tauri
; installs externalBin files WITHOUT the target-triple suffix, so these are the
; installed names (verified against a passive install, 2026-09-17). NSIS
; cannot overwrite a running exe, but Windows lets us rename it and the
; running process keeps its mapped image. The UI deletes *.old on launch
; (ui/src-tauri/src/cleanup.rs); a delete that fails because the old daemon
; still runs is retried next launch. Rename on a missing source is a no-op
; warning, which is what a first install produces.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\termx-host.exe.old"
  Rename "$INSTDIR\termx-host.exe" "$INSTDIR\termx-host.exe.old"
  Delete "$INSTDIR\termx-output.exe.old"
  Rename "$INSTDIR\termx-output.exe" "$INSTDIR\termx-output.exe.old"
!macroend

; Relaunch after a silent update is the template's own /R flag (Function .onInstSuccess),
; so no post-install hook is needed here. TermX passes /S /UPDATE /R /D=<dir>.
