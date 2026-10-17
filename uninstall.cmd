@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0maintenance.ps1" uninstall
if errorlevel 1 exit /b %errorlevel%
pause
