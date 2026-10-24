# Scheduled-task wrapper for vps-backup.ps1.
# Runs the full VPS backup, appends output to backups\backup-task.log,
# and shows a notification about the result.
# Used by the "Alerts VPS Full Backup" scheduled task (every 2 days, 18:00 local).

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $repoRoot 'backups'
$logFile = Join-Path $logDir 'backup-task.log'
$backupScript = Join-Path $repoRoot 'vps-backup.ps1'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Value "===== $timestamp backup started =====" -Encoding UTF8

# Скрипт сохранён в UTF-8 c BOM: без BOM Windows PowerShell 5.1 читает файл
# в ANSI (windows-1251) и ломает кириллицу в title/text попапа.

# Вывод бэкапа стримим в лог построчно: при зависании видно, на каком шаге он встал.
# Out-String буферизовал весь вывод до конца процесса — при убийстве задачи
# планировщиком лог оставался пустым (тихие провалы 14.10 и 16.10.2026).
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript -Action Backup 2>&1 |
    ForEach-Object { Add-Content -Path $logFile -Value $_ -Encoding UTF8 }
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
# Таймаут 300 с: окно само закрывается, даже если никто не нажал OK —
# иначе незакрытый попап держит инстанс задачи (с IgnoreNew это блокирует прогоны).
try {
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.Popup($text, 300, $title, $popupType) | Out-Null
}
catch {
    Add-Content -Path $logFile -Value "===== notification failed: $($_.Exception.Message) =====" -Encoding UTF8
}

exit $exitCode
