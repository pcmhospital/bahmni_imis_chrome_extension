@echo off
REM ============================================================
REM  IMIS Sync — Auto-Updater Installer
REM  Double-click this file to install the auto-updater.
REM  Run as Administrator for Task Scheduler setup.
REM ============================================================
echo.
echo  ========================================
echo   IMIS Sync Auto-Updater Installer
echo  ========================================
echo.

REM --- Check admin ---
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  [!] Please run as Administrator.
    echo      Right-click this file ^> Run as administrator
    echo.
    pause
    exit /b 1
)

REM --- Get extension path ---
set /p "EXT_PATH=  Enter extension folder path (e.g. C:\Users\Dell\Desktop\bahmni_Extension\IMIS-Sync-Extension): "
if not exist "%EXT_PATH%\manifest.json" (
    echo  [!] manifest.json not found in that folder.
    pause
    exit /b 1
)

REM --- Get GitHub token ---
set /p "TOKEN=  Enter GitHub token: "

REM --- Write config ---
echo  Creating updater-config.json ...
(
    echo {
    echo   "githubToken": "%TOKEN%",
    echo   "repoOwner": "pcmhospital",
    echo   "repoName": "bahmni_imis_chrome_extension",
    echo   "extensionPath": "%EXT_PATH%"
    echo }
) > "%EXT_PATH%\updater-config.json"

REM --- Create logs folder ---
if not exist "%EXT_PATH%\logs" mkdir "%EXT_PATH%\logs"

REM --- Register Task Scheduler (runs every hour) ---
echo  Registering Task Scheduler ...
schtasks /Create /TN "IMIS-Sync-Updater" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%EXT_PATH%\updater.ps1\"" /SC HOURLY /RL HIGHEST /F
if %errorLevel% neq 0 (
    echo  [!] Failed to register task. Try running as Administrator.
    pause
    exit /b 1
)

REM --- Run once now to test ---
echo  Running first update check ...
schtasks /Run /TN "IMIS-Sync-Updater"

echo.
echo  ========================================
echo   Installed! Task runs every hour.
echo   Logs: %EXT_PATH%\logs\
echo  ========================================
echo.
pause
