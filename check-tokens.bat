@echo off
setlocal

set INSTALLATION_ID=%~1

if "%INSTALLATION_ID%"=="" (
    echo Использование: check-tokens.bat ^<installation_id^>
    echo.
    echo Пример: check-tokens.bat 7fff3b59-2f6e-45b6-a275-a7d42fba83b7
    pause
    goto end
)

echo ╨Я╤А╨╛╨▓╨╡╤А╨║╨░ ╤В╨╛╨║╨╡╨╜╨╛╨▓ ╨┤╨╗╤П installation_id: %INSTALLATION_ID%
echo.

ssh -i "E:\Dev\Projects\Alerts\VPS-54592" -o StrictHostKeyChecking=no root@173.242.53.129 "psql -U alerts_ua_app -d alerts_ua -t -c \"SELECT token_id, is_active, last_seen_at::text, last_error_code FROM device_push_tokens WHERE installation_id = '%INSTALLATION_ID%' ORDER BY last_seen_at DESC;\""

:end
endlocal
