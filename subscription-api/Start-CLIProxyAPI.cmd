@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CLIProxyAPI.ps1"
set "rc=%ERRORLEVEL%"
pause
exit /b %rc%
