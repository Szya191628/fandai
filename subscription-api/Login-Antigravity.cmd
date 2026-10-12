@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Login-Antigravity.ps1"
set "rc=%ERRORLEVEL%"
pause
exit /b %rc%
