@echo off
setlocal EnableDelayedExpansion

rem Проверка аргументов
if "%~1"=="" goto usage
if "%~2"=="" goto usage
if "%~3"=="" goto usage

set "SSH_KEY=E:\Dev\Projects\Alerts\VPS-54592"
set "SSH_USER=root@173.242.53.129"
set TUNNEL_PORT=15432

rem Очищаем старые туннели
echo ╨ЬЧ ╨Ю╤З╨╕╤Б╤В╨║╨░ SSH ╤В╤Г╨╜╨╜╨╡╨╗╨╡╨╣...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%TUNNEL_PORT%.*LISTENING" 2^>nul') do (
    echo   ╨Ч╨▒╨╕╨▓╨░╨╡╨╝ ╨┐╤А╨╛╤Ж╨╡╤Б╤Б %%a
    taskkill /F /PID %%a 2>nul
)
timeout /t 1 /nobreak >nul

echo.
echo ╨Х╨Р╨╖╨░╨╜╨╕╨╡ SSH ╤В╤Г╨╜╨╜╨╡╨╗╤П ╨║ VPS...
echo.

"C:\Program Files\Git\usr\bin\ssh.exe" -f -N -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -i "%SSH_KEY%" -L %TUNNEL_PORT%:127.0.0.1:5432 %SSH_USER%

if errorlevel 1 (
    echo.
    echo ❌ Ошибка создания SSH туннеля
    pause
    goto end
)

timeout /t 2 /nobreak >nul

echo ✅ Туннель создан (порт %TUNNEL_PORT%)
echo.

set "DATABASE_URL=postgresql://alerts_ua_app:luz1NE2fde1vOd9e0@127.0.0.1:%TUNNEL_PORT%/alerts_ua"
set "FIREBASE_SERVICE_ACCOUNT_PATH=E:\Dev\Projects\Alerts\alert-ua-app-firebase-adminsdk-fbsvc-48f98daed8.json"

cd backend
npm run send-notification -- %~1 "%~2" "%~3"

rem Закрываем туннель
echo.
echo 🔚 Закрытие SSH туннеля...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%TUNNEL_PORT%.*LISTENING" 2^>nul') do (
    taskkill /F /PID %%a 2>nul
)

goto end

:usage
echo Использование: send-notification.bat ^<installation_id^> ^<заголовок^> ^<текст^>
echo.
echo Пример:
echo   send-notification.bat 123e4567-e89b-12d3-a456-426614174000 "Тест" "Привет мир"
echo.
echo Если FCM токен недействителен:
echo   1. Открой приложение на телефоне
echo   2. Перейди в Настройки → Уведомления
echo   3. Выключи и включи уведомления (для обновления токена)

:end
endlocal
