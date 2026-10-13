@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run npm install first.
  echo If using pnpm, run pnpm install and pnpm desktop:install.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.cjs"
