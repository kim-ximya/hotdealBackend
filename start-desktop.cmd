@echo off
setlocal
cd /d "%~dp0"
if exist ".local\tauri-tools\cargo\bin\cargo.exe" (
  set "CARGO_HOME=%~dp0.local\tauri-tools\cargo"
  set "RUSTUP_HOME=%~dp0.local\tauri-tools\rustup"
  set "PATH=%~dp0.local\tauri-tools\cargo\bin;%PATH%"
)
if not exist "node_modules\@tauri-apps\cli\tauri.js" (
  echo Tauri CLI is not installed. Run pnpm install first.
  exit /b 1
)
node build\prepare-tauri.cjs
if errorlevel 1 exit /b %ERRORLEVEL%
node node_modules\@tauri-apps\cli\tauri.js dev --no-dev-server -- --locked
exit /b %ERRORLEVEL%
