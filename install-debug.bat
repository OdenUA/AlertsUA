@echo off
setlocal enabledelayedexpansion

if not exist "%~dp0secrets.env" (
    echo [!] secrets.env not found. Copy secrets.env.example to secrets.env and fill in values.
    pause
    exit /b 1
)
for /f "usebackq tokens=1* delims==" %%A in ("%~dp0secrets.env") do (
    set "_ln=%%A"
    if not "!_ln:~0,1!"=="#" if not "!_ln!"=="" set "%%A=%%B"
)

set "ADB=E:\Dev\Android\SDK\platform-tools\adb.exe"
set "APK=%~dp0android-app\app\build\outputs\apk\debug\app-debug.apk"
set "PACKAGE=com.alertsua.app"

if not exist "%APK%" (
    echo [!] APK not found: %APK%
    echo     Run build-debug.bat first.
    pause
    exit /b 1
)

echo [*] Looking for an active emulator...
set "EMULATOR="
for /f "tokens=1,2" %%A in ('"%ADB%" devices') do (
    set "_serial=%%A"
    if "%%B"=="device" if "!_serial:~0,9!"=="emulator-" if not defined EMULATOR set "EMULATOR=%%A"
)

if not defined EMULATOR (
    echo [!] No active emulator found. Start it with start-emulator.bat first.
    pause
    exit /b 1
)

echo [*] Found emulator: %EMULATOR%

echo [*] Installing APK on %EMULATOR%...
"%ADB%" -s %EMULATOR% shell pm clear com.alertsua.app
"%ADB%" -s %EMULATOR% shell pm clear com.scmv.android.debug
"%ADB%" -s %EMULATOR% install -r "%APK%"
if %ERRORLEVEL% neq 0 (
    echo [!] Installation failed.
    pause
    exit /b %ERRORLEVEL%
)

echo [*] Restarting app...
"%ADB%" -s %EMULATOR% shell am force-stop %PACKAGE%
"%ADB%" -s %EMULATOR% shell am start -W -n %PACKAGE%/.MainActivity

echo.
echo [+] App launched on %EMULATOR%.
echo [i] Use logcat-app.bat for Alerts-only runtime and crash logs.
endlocal
