# VPS full backup / restore orchestrator (Alerts UA + Dtek + PoeNotif)
# Runs locally on Windows.
#
#   .\vps-backup.ps1 -Action Backup
#       Creates a full backup on the source VPS (VPS_SSH_USER/VPS_SSH_KEY from secrets.env
#       or -SourceHost/-SourceKey) and downloads it to .\backups\
#
#   .\vps-backup.ps1 -Action Restore -TargetHost root@NEW_IP -TargetKey key [-Archive path]
#       Uploads the archive to a FRESH Debian 12 VPS and fully restores all services
#       (packages, PostgreSQL roles+DBs, trees, systemd, nginx, cron, health-checks).
#
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Backup', 'Restore')]
    [string]$Action,

    [string]$SourceHost,
    [string]$SourceKey,
    [string]$TargetHost,
    [string]$TargetKey,
    [string]$Archive,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Fail {
    param([string]$Message)
    Write-Fail $Message
    throw $Message
}

function Import-EnvFile {
    param([string]$Path)
    $result = @{}
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
        if ($line -match '^\s*([^=\s]+)\s*=(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $result[$name] = $value
        }
    }
    return $result
}

function Find-SSHTool {
    param([string]$Name)
    $gitPath = "C:\Program Files\Git\usr\bin\$Name.exe"
    if (Test-Path $gitPath) { return $gitPath }
    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    Fail "Required tool '$Name' was not found in PATH or Git Bash."
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$secretsPath = Join-Path $repoRoot 'secrets.env'
$backupScript = Join-Path $repoRoot 'infra\vps\scripts\backup-full-vps.sh'
$restoreScript = Join-Path $repoRoot 'infra\vps\scripts\restore-full-vps.sh'
$backupsDir = Join-Path $repoRoot 'backups'

$sshExe = Find-SSHTool -Name 'ssh'
$scpExe = Find-SSHTool -Name 'scp'
$shaExe = Find-SSHTool -Name 'sha256sum'

$envFile = @{}
if (Test-Path $secretsPath) { $envFile = Import-EnvFile -Path $secretsPath }

function Resolve-Connection {
    param([string]$HostParam, [string]$KeyParam, [string]$Purpose)

    $user = if (-not [string]::IsNullOrWhiteSpace($HostParam)) { $HostParam }
            elseif ($envFile.ContainsKey('VPS_SSH_USER')) { $envFile['VPS_SSH_USER'] }
            else { '' }
    $key = if (-not [string]::IsNullOrWhiteSpace($KeyParam)) { $KeyParam }
           elseif ($envFile.ContainsKey('VPS_SSH_KEY')) { $envFile['VPS_SSH_KEY'] }
           else { '' }

    if ([string]::IsNullOrWhiteSpace($user)) { Fail "No SSH target for ${Purpose}. Pass -${Purpose}Host or configure VPS_SSH_USER in secrets.env." }
    if ([string]::IsNullOrWhiteSpace($key)) { Fail "No SSH key for ${Purpose}. Pass -${Purpose}Key or configure VPS_SSH_KEY in secrets.env." }
    if (-not (Test-Path $key)) { Fail "SSH key file not found: $key" }

    return @{ Target = $user; Key = $key }
}

function New-SshArgs {
    param([string]$Key)
    return @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=30')
}

function Test-TargetReachable {
    param([hashtable]$Conn, [string]$Label)
    Write-Step "Checking SSH connectivity to ${Label} ($($Conn.Target))..."
    & $sshExe @(New-SshArgs $Conn.Key) -n $Conn.Target 'echo ok' | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Cannot connect to $($Conn.Target) via SSH." }
    Write-Success "SSH connection OK"
}

# ============================ BACKUP ============================
function Invoke-Backup {
    $conn = Resolve-Connection -HostParam $SourceHost -KeyParam $SourceKey -Purpose 'Source'
    Test-TargetReachable -Conn $conn -Label 'source VPS'

    if (-not (Test-Path $backupScript)) { Fail "Backup script not found: $backupScript" }
    if (-not (Test-Path $backupsDir)) { New-Item -ItemType Directory -Path $backupsDir | Out-Null }

    Write-Step "Uploading backup script..."
    & $sshExe @(New-SshArgs $conn.Key) -n $conn.Target 'mkdir -p /root/full-backup'
    & $scpExe @(New-SshArgs $conn.Key) $backupScript "$($conn.Target):/root/full-backup/backup-full-vps.sh"
    if ($LASTEXITCODE -ne 0) { Fail "Failed to upload backup script." }

    Write-Step "Running backup on VPS (this takes several minutes)..."
    $remoteOutput = & $sshExe @(New-SshArgs $conn.Key) $conn.Target 'bash /root/full-backup/backup-full-vps.sh'
    if ($LASTEXITCODE -ne 0) {
        $remoteOutput | ForEach-Object { Write-Host $_ }
        Fail "Remote backup script failed."
    }
    $remoteOutput | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }

    $archivePath = ($remoteOutput | Where-Object { $_ -match '^ARCHIVE_PATH=(\S+)' } | Select-Object -First 1)
    if (-not $archivePath) { Fail "Backup script did not report ARCHIVE_PATH." }
    $remoteArchive = $Matches[1]
    $remoteSha = ($remoteOutput | Where-Object { $_ -match '^ARCHIVE_SHA256=(\S+)' } | Select-Object -First 1)
    $remoteSha = if ($remoteSha) { $Matches[1] } else { '' }

    $localName = Split-Path $remoteArchive -Leaf
    $localPath = Join-Path $backupsDir $localName

    Write-Step "Downloading archive..."
    & $scpExe @(New-SshArgs $conn.Key) "$($conn.Target):$remoteArchive" $localPath
    if ($LASTEXITCODE -ne 0) { Fail "Failed to download archive." }

    if ($remoteSha) {
        Write-Step "Verifying sha256..."
        # Git Bash sha256sum экранирует вывод, если путь содержит '\' — передаём имя файла без пути
        Push-Location (Split-Path $localPath -Parent)
        try {
            $localSha = (& $shaExe (Split-Path $localPath -Leaf)) -split '\s+' | Select-Object -First 1
        }
        finally {
            Pop-Location
        }
        $localSha = $localSha.TrimStart('\')
        if ($localSha -ne $remoteSha) { Fail "SHA256 mismatch! local=$localSha remote=$remoteSha" }
        Write-Success "SHA256 verified: $localSha"
    }

    Write-Step "Removing previous local backups..."
    $removed = 0
    Get-ChildItem -Path $backupsDir -Filter 'vps-full-backup-*.tar.gz' |
        Where-Object { $_.FullName -ne $localPath } |
        ForEach-Object {
            Write-Host "  - deleting $($_.Name)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Force
            $removed++
        }
    if ($removed -gt 0) { Write-Success "Removed $removed previous archive(s)" }
    else { Write-Host "  - no previous archives" -ForegroundColor DarkGray }

    $sizeMB = [math]::Round((Get-Item $localPath).Length / 1MB, 1)
    Write-Success "Backup downloaded: $localPath ($sizeMB MB)"
    Write-Host "A copy remains on the VPS at $remoteArchive"
}

# ============================ RESTORE ============================
function Invoke-Restore {
    if ([string]::IsNullOrWhiteSpace($TargetHost)) {
        Fail "-TargetHost is required for Restore (e.g. root@NEW_IP). Source VPS credentials are NOT used as a default for safety."
    }
    $conn = Resolve-Connection -HostParam $TargetHost -KeyParam $TargetKey -Purpose 'Target'
    Test-TargetReachable -Conn $conn -Label 'target VPS'

    if ([string]::IsNullOrWhiteSpace($Archive)) {
        $latest = Get-ChildItem -Path $backupsDir -Filter 'vps-full-backup-*.tar.gz' -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $latest) { Fail "No archive specified and no backups\vps-full-backup-*.tar.gz found locally." }
        $Archive = $latest.FullName
    }
    if (-not (Test-Path $Archive)) { Fail "Archive not found: $Archive" }
    if (-not (Test-Path $restoreScript)) { Fail "Restore script not found: $restoreScript" }

    $archiveName = Split-Path $Archive -Leaf
    Write-Step "Archive: $Archive ($([math]::Round((Get-Item $Archive).Length / 1MB, 1)) MB)"
    Write-Step "Target:  $($conn.Target)"
    Write-Host ""
    Write-Host "WARNING: restore is DESTRUCTIVE on the target (drops alerts_ua/poe2notif DBs," -ForegroundColor Yellow
    Write-Host "overwrites /srv/alerts-ua, /root/dtek-scraper, /opt/poe2notif, systemd, nginx, crontab)." -ForegroundColor Yellow
    Write-Host ""

    if ($DryRun) {
        Write-Host "[dry-run] scp $Archive -> $($conn.Target):/root/full-backup/$archiveName"
        Write-Host "[dry-run] scp $restoreScript -> $($conn.Target):/root/full-backup/restore-full-vps.sh"
        Write-Host "[dry-run] ssh $($conn.Target) bash /root/full-backup/restore-full-vps.sh --archive /root/full-backup/$archiveName"
        return
    }

    Write-Step "Uploading archive and restore script..."
    & $sshExe @(New-SshArgs $conn.Key) -n $conn.Target 'mkdir -p /root/full-backup'
    & $scpExe @(New-SshArgs $conn.Key) $Archive "$($conn.Target):/root/full-backup/$archiveName"
    if ($LASTEXITCODE -ne 0) { Fail "Failed to upload archive." }
    & $scpExe @(New-SshArgs $conn.Key) $restoreScript "$($conn.Target):/root/full-backup/restore-full-vps.sh"
    if ($LASTEXITCODE -ne 0) { Fail "Failed to upload restore script." }

    Write-Step "Running restore on target VPS (packages, DBs, services)..."
    $remoteOutput = & $sshExe @(New-SshArgs $conn.Key) $conn.Target "bash /root/full-backup/restore-full-vps.sh --archive /root/full-backup/$archiveName"
    $exitCode = $LASTEXITCODE
    $remoteOutput | ForEach-Object {
        if ($_ -match '^\[PASS\]') { Write-Host $_ -ForegroundColor Green }
        elseif ($_ -match '^\[FAIL\]|ERROR') { Write-Host $_ -ForegroundColor Red }
        else { Write-Host "  | $_" -ForegroundColor DarkGray }
    }

    if ($exitCode -ne 0) {
        Write-Fail "Restore finished with failures on target (exit code $exitCode)."
        exit 1
    }
    Write-Success "Restore completed successfully on $($conn.Target)"
}

# ============================ MAIN ============================
Write-Step "========================================="
Write-Step "VPS Full Backup/Restore (Alerts + Dtek + PoeNotif)"
Write-Step "========================================="

if ($DryRun -and $Action -eq 'Backup') {
    $conn = Resolve-Connection -HostParam $SourceHost -KeyParam $SourceKey -Purpose 'Source'
    Write-Host "[dry-run] scp $backupScript -> $($conn.Target):/root/full-backup/"
    Write-Host "[dry-run] ssh $($conn.Target) bash /root/full-backup/backup-full-vps.sh"
    Write-Host "[dry-run] scp $($conn.Target):/root/full-backup/vps-full-backup-<date>.tar.gz -> $backupsDir"
    return
}

if ($Action -eq 'Backup') { Invoke-Backup } else { Invoke-Restore }
