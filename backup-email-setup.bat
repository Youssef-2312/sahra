@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20 or newer from https://nodejs.org
  pause
  exit /b 1
)
set "SAHRA_HELPER=%LOCALAPPDATA%\Sahra\backup-email-helper"
if not exist "%SAHRA_HELPER%\node_modules\playwright\index.mjs" (
  echo Installing the browser helper outside the repository...
  set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
  call npm install --prefix "%SAHRA_HELPER%" --no-audit --no-fund playwright@1.64.1
  if errorlevel 1 (
    echo Installation failed. No account settings were changed.
    pause
    exit /b 1
  )
)
node scripts\backup-email-setup.mjs
set "SAHRA_EXIT=%ERRORLEVEL%"
pause
exit /b %SAHRA_EXIT%
