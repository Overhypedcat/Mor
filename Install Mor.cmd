@echo off
rem Double-click to set Mor up (or repair it). See tools\install.ps1 for each step.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
echo.
pause
