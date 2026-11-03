@echo off
rem Has Mozilla sign Mor's extension (unlisted) and puts Mor.xpi beside Install Mor.cmd. See sign.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign.ps1"
echo.
pause
