; Uninstall: remove the model gateway's runtime (Python and its packages). It is re-downloaded on the
; next first start, so it is removed even though settings and provider keys in %APPDATA% are kept.
; Skipped during updates, so updating doesn't force a new download. Folder name: DATA_FOLDER-runtime
; (src/shared/brand.ts).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Programs\mooch-runtime"
  ${endIf}
!macroend
