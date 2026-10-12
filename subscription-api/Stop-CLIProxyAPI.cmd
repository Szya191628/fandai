@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-CLIProxyAPI.ps1"
set "rc=%ERRORLEVEL%"
pause
exit /b %rc%
