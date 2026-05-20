@echo off
setlocal

rem Проверка аргументов
if "%~1"=="" goto usage
if "%~2"=="" goto usage
if "%~3"=="" goto usage

set SSH_KEY=E:\Dev\Projects\Alerts\VPS-54592
set SSH_USER=root@173.242.53.129

echo 🚀 Запуск скрипта на VPS...
echo.

rem Экранируем кавычки для передачи через SSH
set TITLE=%~2
set BODY=%~3

ssh -i "%SSH_KEY%" %SSH_USER% "cd /srv/alerts-ua/app/current && npm run send-notification -- %~1 '%TITLE%' '%BODY%'"

goto end

:usage
echo Использование: send-notification-vps.bat ^<installation_id^> ^<заголовок^> ^<текст^>
echo.
echo Пример:
echo   send-notification-vps.bat 123e4567-e89b-12d3-a456-426614174000 "Тест" "Привет мир"

:end
endlocal
