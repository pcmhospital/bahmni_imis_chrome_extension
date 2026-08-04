#Requires -Version 5.1
<#
.SYNOPSIS
    IMIS Sync — Auto-updater for Chrome extension.
.DESCRIPTION
    Checks GitHub for a newer version, downloads the ZIP, extracts and replaces
    the extension files, then shows a notification to reload at chrome://extensions.
    Designed to run via Task Scheduler on hospital PCs.
.NOTES
    Configure token and paths in updater-config.json next to this script.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# --- Configuration ---
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath  = Join-Path $ScriptDir "updater-config.json"
$LogDir      = Join-Path $ScriptDir "logs"
$LogFile     = Join-Path $LogDir ("updater-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

# --- Helpers ---
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $ts    = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line  = "[$ts] [$Level] $Message"
    Add-Content -Path $LogFile -Value $line
    if ($Level -eq "ERROR") { Write-Error $Message }
    elseif ($Level -eq "WARN") { Write-Warning $Message }
    else { Write-Verbose $Message }
}

function Show-Notification {
    param([string]$Title, [string]$Text)
    try {
        [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
        $notify = New-Object System.Windows.Forms.NotifyIcon
        $notify.Icon              = [System.Drawing.SystemIcons]::Information
        $notify.BalloonTipIcon    = [System.Drawing.SystemIcons]::Information
        $notify.BalloonTipTitle   = $Title
        $notify.BalloonTipText    = $Text
        $notify.Visible           = $true
        $notify.ShowBalloonTip(10000)
        Start-Sleep -Seconds 12
        $notify.Dispose()
    } catch {
        # Fallback: just log it
        Write-Log "Notification failed: $_" "WARN"
    }
}

function Get-VersionParts {
    param([string]$Version)
    return $Version.Split(".") | ForEach-Object { [int]$_ }
}

function Compare-Versions {
    param([string]$Remote, [string]$Local)
    $r = Get-VersionParts $Remote
    $l = Get-VersionParts $Local
    $len = [Math]::Max($r.Count, $l.Count)
    for ($i = 0; $i -lt $len; $i++) {
        $rv = if ($i -lt $r.Count) { $r[$i] } else { 0 }
        $lv = if ($i -lt $l.Count) { $l[$i] } else { 0 }
        if ($rv -gt $lv) { return 1 }
        if ($rv -lt $lv) { return -1 }
    }
    return 0
}

# --- Load Config ---
if (-not (Test-Path $ConfigPath)) {
    Write-Log "Config not found at $ConfigPath. Run install-updater.bat first." "ERROR"
    exit 1
}

$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$githubToken   = $cfg.githubToken
$repoOwner     = $cfg.repoOwner
$repoName      = $cfg.repoName
$extensionPath = $cfg.extensionPath

if (-not $githubToken -or -not $extensionPath) {
    Write-Log "Config missing githubToken or extensionPath." "ERROR"
    exit 1
}

# --- Main ---
try {
    Write-Log "=== Update check started ==="

    # 1. Read current version from manifest.json
    $manifestPath = Join-Path $extensionPath "manifest.json"
    if (-not (Test-Path $manifestPath)) {
        Write-Log "manifest.json not found at $manifestPath" "ERROR"
        exit 1
    }
    $manifest  = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $localVer  = $manifest.version
    Write-Log "Local version: $localVer"

    # 2. Fetch remote version.json from GitHub API
    $apiUrl = "https://api.github.com/repos/$repoOwner/$repoName/contents/version.json"
    $headers = @{
        "Authorization" = "Bearer $githubToken"
        "Accept"        = "application/vnd.github.v3+json"
    }
    Write-Log "Fetching $apiUrl"

    $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -UseBasicParsing
    $jsonBytes = [Convert]::FromBase64String($response.content -replace "\n","")
    $jsonText  = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
    $remoteCfg = $jsonText | ConvertFrom-Json
    $remoteVer = $remoteCfg.version
    Write-Log "Remote version: $remoteVer"

    # 3. Compare
    $cmp = Compare-Versions -Remote $remoteVer -Local $localVer
    if ($cmp -le 0) {
        Write-Log "Already up to date ($localVer)."
        exit 0
    }

    Write-Log "New version available: $remoteVer (current: $localVer)"

    # 4. Download ZIP
    $zipUrl  = $remoteCfg.zip_url
    if (-not $zipUrl) {
        $zipUrl = "https://github.com/$repoOwner/$repoName/releases/download/v$remoteVer/IMIS-Sync-Extension.zip"
    }
    $tempZip = Join-Path $env:TEMP ("IMIS-Sync-Extension-{0}.zip" -f $remoteVer)
    Write-Log "Downloading $zipUrl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing -Headers @{ "Authorization" = "Bearer $githubToken" }

    # 5. Extract to temp folder
    $tempExtract = Join-Path $env:TEMP ("IMIS-Sync-extract-{0}" -f $remoteVer)
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

    # 6. Find the actual content (ZIP might have a top-level folder)
    $sourceDir = $tempExtract
    $items = Get-ChildItem $tempExtract
    if ($items.Count -eq 1 -and $items[0].PSIsContainer) {
        $sourceDir = $items[0].FullName
    }

    # 7. Backup old version
    $backupPath = Join-Path $env:TEMP ("IMIS-Sync-backup-{0}" -f $localVer)
    if (Test-Path $backupPath) { Remove-Item $backupPath -Recurse -Force }
    Copy-Item -Path $extensionPath -Destination $backupPath -Recurse -Force
    Write-Log "Old version backed up to $backupPath"

    # 8. Remove old files (keep logs and config)
    $keepItems = @("logs", "updater-config.json", "install-updater.bat", "uninstall-updater.bat")
    Get-ChildItem $extensionPath | Where-Object { $_.Name -notin $keepItems } | Remove-Item -Recurse -Force

    # 9. Copy new files
    Copy-Item -Path "$sourceDir\*" -Destination $extensionPath -Recurse -Force
    Write-Log "Extension updated to v$remoteVer"

    # 10. Cleanup temp
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue

    # 11. Notify user
    Show-Notification -Title "IMIS Sync Updated" -Text "Updated to v$remoteVer. Go to chrome://extensions and click the reload button on IMIS Sync."
    Write-Log "=== Update complete: v$localVer -> v$remoteVer ==="

} catch {
    Write-Log "Update failed: $($_.Exception.Message)" "ERROR"
    exit 1
}
