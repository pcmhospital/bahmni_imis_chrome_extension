@echo off
REM ============================================================
REM  IMIS Sync — Check for Updates Now
REM  Double-click to check immediately (runs in background).
REM ============================================================
echo  Checking for updates ...
start /B powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0updater.ps1"
echo  Done. Check logs folder for results.
timeout /t 3 >nul
