!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's updater passes /UPDATE to the previous uninstaller.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  IfErrors 0 hotdeal_startup_done
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "핫딜 수집 관리자"
  StrCmp $R0 '$\"$INSTDIR\hotdeal-collector.exe$\" hotdeal-windows-startup' 0 hotdeal_startup_done
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "핫딜 수집 관리자"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "핫딜 수집 관리자"
  hotdeal_startup_done:
!macroend
