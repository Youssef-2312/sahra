@echo off
rem Sahra: sets the platform Gmail accounts (up to 3) from email-accounts.txt.
rem Double-click it, or run: email-accounts.bat staging   /   email-accounts.bat production
rem The list stays on this computer (it is in .gitignore). See scripts\email-accounts.mjs.
cd /d "%~dp0"
node scripts\email-accounts.mjs %*
echo.
pause
