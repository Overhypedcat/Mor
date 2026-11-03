@echo off
rem Double-click to remove Mor's helper and data from this PC. See tools\uninstall.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\uninstall.ps1"
echo.
pause
