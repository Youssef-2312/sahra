@echo off
rem Sahra owner setup for Windows. Double-click to open the menu.
rem Every step is safe to run again (see scripts\ops.mjs). Production steps ask you
rem to type PROD first. Secret values are generated and piped into Cloudflare;
rem they are never shown.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\wrangler\package.json (
  echo Installing dependencies ^(npm ci^)...
  call npm ci
  if errorlevel 1 (
    echo npm ci failed.
    pause
    exit /b 1
  )
)

:menu
echo.
echo ================= Sahra setup =================
echo  Before merging the pull request
echo    1  Sign in to Cloudflare (only if needed)
echo    2  Apply migrations to STAGING (+ staging-only tables)
echo    3  Apply migrations to PRODUCTION
echo    4  Show migration status (all four databases)
echo  After the first deploy
echo    5  Create missing secrets on STAGING
echo    6  Create missing secrets on PRODUCTION
echo    7  Set the Google client secret on STAGING
echo    8  Set the Google client secret on PRODUCTION
echo    9  Create a party (staging or production)
echo  Checkpoint A
echo   10  Run Checkpoint A against STAGING
echo   11  Verify ledger records vs admitted tickets (STAGING, read-only)
echo    0  Exit
echo ================================================
set "choice="
set /p "choice=Step number: "
if "%choice%"=="0" exit /b 0
if "%choice%"=="1" node scripts\ops.mjs login
if "%choice%"=="2" node scripts\ops.mjs migrate staging
if "%choice%"=="3" node scripts\ops.mjs migrate prod
if "%choice%"=="4" node scripts\ops.mjs status
if "%choice%"=="5" node scripts\ops.mjs secrets staging
if "%choice%"=="6" node scripts\ops.mjs secrets prod
if "%choice%"=="7" node scripts\ops.mjs google-secret staging
if "%choice%"=="8" node scripts\ops.mjs google-secret prod
if "%choice%"=="9" node scripts\ops.mjs create-party
if "%choice%"=="10" node scripts\ops.mjs checkpoint
if "%choice%"=="11" node scripts\ops.mjs verify-ledger
pause
goto menu
