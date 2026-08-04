@echo off
REM ============================================================
REM  IMIS Sync — Auto-Updater Uninstaller
REM ============================================================
echo.
echo  ========================================
echo   IMIS Sync Auto-Updater Uninstaller
echo  ========================================
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  [!] Please run as Administrator.
    pause
    exit /b 1
)

echo  Removing Task Scheduler task ...
schtasks /Delete /TN "IMIS-Sync-Updater" /F 2>nul
if %errorLevel% equ 0 (
    echo  Task removed successfully.
) else (
    echo  Task was not found.
)

echo.
echo  Done. The updater will no longer run.
echo.
pause
