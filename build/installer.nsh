!macro customUnInstall
  ; Remove only the startup entry pointing at this installation. Keep dev/other installs.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "핫딜 수집 관리자"
  StrCmp $0 '$\"$INSTDIR\HotdealCollector.exe$\" hotdeal-windows-startup' 0 hotdeal_startup_done
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "핫딜 수집 관리자"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "핫딜 수집 관리자"
  hotdeal_startup_done:
!macroend
