# Scheduled-task wrapper for vps-backup.ps1.
# Runs the full VPS backup, appends output to backups\backup-task.log,
# and shows a notification about the result.
# Used by the "Alerts VPS Full Backup" scheduled task (every 2 days, 21:00 local).

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $repoRoot 'backups'
$logFile = Join-Path $logDir 'backup-task.log'
$backupScript = Join-Path $repoRoot 'vps-backup.ps1'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Value "===== $timestamp backup started =====" -Encoding UTF8

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -Action Backup *>> $logFile
$exitCode = $LASTEXITCODE

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
if ($exitCode -eq 0) {
    Add-Content -Path $logFile -Value "===== $timestamp backup SUCCESS =====" -Encoding UTF8
    $title = 'VPS Backup: успех'
    $text = "Полный бэкап VPS (Alerts + Dtek + PoeNotif) успешно создан и скачан.`nЛог: backups\backup-task.log"
    $popupType = 64   # информационная иконка
}
else {
    Add-Content -Path $LogFile -Value "===== $timestamp backup FAILED (exit code $exitCode) =====" -Encoding UTF8
    $title = 'VPS Backup: ошибка'
    $text = "Бэкап VPS завершился с ошибкой (exit code $exitCode).`nСм. лог: backups\backup-task.log"
    $popupType = 16   # иконка ошибки
}

# Уведомление через WScript.Shell.Popup: надёжно работает из задач планировщика
# (NotifyIcon.ShowBalloonTip из-под scheduled task зависает).
# Таймаут 0 — окно не закрывается само, только по кнопке OK.
try {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.Popup($text, 0, $title, $popupType) | Out-Null
}
catch {
    Add-Content -Path $logFile -Value "===== notification failed: $($_.Exception.Message) =====" -Encoding UTF8
}

exit $exitCode
